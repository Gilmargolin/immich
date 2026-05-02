import { Injectable } from '@nestjs/common';
import { LockableProperty } from 'src/database';
import { SystemConfig } from 'src/config';
import { JOBS_ASSET_PAGINATION_SIZE } from 'src/constants';
import { OnEvent, OnJob } from 'src/decorators';
import { AssetVisibility, DatabaseLock, ImmichWorker, JobName, JobStatus, QueueName } from 'src/enum';
import { ArgOf } from 'src/repositories/event.repository';
import { BaseService } from 'src/services/base.service';
import { JobItem, JobOf } from 'src/types';
import { getCLIPModelInfo, isSmartSearchEnabled } from 'src/utils/misc';

// Mobile editor (App Store build) saves edits as new local files named
// "<original>_edited.jpg" (or .jpeg/.png). The bytes are PNG with stripped EXIF
// and PHAsset.creationDate stamped to "now", so the new asset arrives at the
// server with no parent reference and today's date everywhere. We detect the
// filename pattern and inherit metadata from the visually-similar parent (via
// CLIP embedding) discovered earlier in the same user's library.
const EDITED_FILENAME_REGEX = /_edited\.(jpe?g|png)$/i;
// Cosine distance threshold. CLIP same-photo cosine sim ~0.97+, sibling photos
// drop below ~0.90; 0.05 distance ≈ 0.95 sim is the comfortable separation.
const EDITED_PARENT_DISTANCE_MAX = 0.05;

@Injectable()
export class SmartInfoService extends BaseService {
  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    await this.init(newConfig);
  }

  @OnEvent({ name: 'ConfigUpdate', workers: [ImmichWorker.Microservices], server: true })
  async onConfigUpdate({ oldConfig, newConfig }: ArgOf<'ConfigUpdate'>) {
    await this.init(newConfig, oldConfig);
  }

  @OnEvent({ name: 'ConfigValidate' })
  onConfigValidate({ newConfig }: ArgOf<'ConfigValidate'>) {
    try {
      getCLIPModelInfo(newConfig.machineLearning.clip.modelName);
    } catch {
      throw new Error(
        `Unknown CLIP model: ${newConfig.machineLearning.clip.modelName}. Please check the model name for typos and confirm this is a supported model.`,
      );
    }
  }

  private async init(newConfig: SystemConfig, oldConfig?: SystemConfig) {
    if (!isSmartSearchEnabled(newConfig.machineLearning)) {
      return;
    }

    await this.databaseRepository.withLock(DatabaseLock.CLIPDimSize, async () => {
      const { dimSize } = getCLIPModelInfo(newConfig.machineLearning.clip.modelName);
      const dbDimSize = await this.databaseRepository.getDimensionSize('smart_search');
      this.logger.verbose(`Current database CLIP dimension size is ${dbDimSize}`);

      const modelChange =
        oldConfig && oldConfig.machineLearning.clip.modelName !== newConfig.machineLearning.clip.modelName;
      const dimSizeChange = dbDimSize !== dimSize;
      if (!modelChange && !dimSizeChange) {
        return;
      }

      if (dimSizeChange) {
        this.logger.log(
          `Dimension size of model ${newConfig.machineLearning.clip.modelName} is ${dimSize}, but database expects ${dbDimSize}.`,
        );
        this.logger.log(`Updating database CLIP dimension size to ${dimSize}.`);
        await this.databaseRepository.setDimensionSize(dimSize);
        this.logger.log(`Successfully updated database CLIP dimension size from ${dbDimSize} to ${dimSize}.`);
      } else {
        await this.databaseRepository.deleteAllSearchEmbeddings();
      }

      // TODO: A job to reindex all assets should be scheduled, though user
      // confirmation should probably be requested before doing that.
    });
  }

  @OnJob({ name: JobName.SmartSearchQueueAll, queue: QueueName.SmartSearch })
  async handleQueueEncodeClip({ force }: JobOf<JobName.SmartSearchQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    if (force) {
      const { dimSize } = getCLIPModelInfo(machineLearning.clip.modelName);
      // in addition to deleting embeddings, update the dimension size in case it failed earlier
      await this.databaseRepository.setDimensionSize(dimSize);
    }

    let queue: JobItem[] = [];
    const assets = this.assetJobRepository.streamForEncodeClip(force);
    for await (const asset of assets) {
      queue.push({ name: JobName.SmartSearch, data: { id: asset.id } });
      if (queue.length >= JOBS_ASSET_PAGINATION_SIZE) {
        await this.jobRepository.queueAll(queue);
        queue = [];
      }
    }

    await this.jobRepository.queueAll(queue);

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.SmartSearch, queue: QueueName.SmartSearch })
  async handleEncodeClip({ id }: JobOf<JobName.SmartSearch>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isSmartSearchEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForClipEncoding(id);
    if (!asset || asset.files.length !== 1) {
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }

    const embedding = await this.machineLearningRepository.encodeImage(asset.files[0].path, machineLearning.clip);

    if (this.databaseRepository.isBusy(DatabaseLock.CLIPDimSize)) {
      this.logger.verbose(`Waiting for CLIP dimension size to be updated`);
      await this.databaseRepository.wait(DatabaseLock.CLIPDimSize);
    }

    const newConfig = await this.getConfig({ withCache: true });
    if (machineLearning.clip.modelName !== newConfig.machineLearning.clip.modelName) {
      // Skip the job if the model has changed since the embedding was generated.
      return JobStatus.Skipped;
    }

    await this.searchRepository.upsert(asset.id, embedding);

    if (EDITED_FILENAME_REGEX.test(asset.originalFileName)) {
      await this.jobRepository.queue({ name: JobName.AssetFindEditedParent, data: { id: asset.id } });
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetFindEditedParent, queue: QueueName.BackgroundTask })
  async handleFindEditedParent({ id }: JobOf<JobName.AssetFindEditedParent>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForClipEncoding(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    if (!EDITED_FILENAME_REGEX.test(asset.originalFileName)) {
      return JobStatus.Skipped;
    }

    const parent = await this.searchRepository.findEditedParent({
      assetId: asset.id,
      ownerId: asset.ownerId,
      distanceMax: EDITED_PARENT_DISTANCE_MAX,
    });

    if (!parent) {
      this.logger.debug(`No similar parent found for edited asset ${asset.id} (${asset.originalFileName})`);
      return JobStatus.Skipped;
    }

    if (!parent.dateTimeOriginal) {
      this.logger.debug(`Parent ${parent.id} for edited asset ${asset.id} has no dateTimeOriginal; skipping`);
      return JobStatus.Skipped;
    }

    // Asset table: dates that drive timeline placement.
    await this.assetRepository.update({
      id: asset.id,
      fileCreatedAt: parent.dateTimeOriginal,
      fileModifiedAt: parent.fileModifiedAt,
      localDateTime: parent.localDateTime,
    });

    // asset_exif table: lock the date and GPS fields so a metadata re-extraction
    // won't overwrite them back to today / null. Camera fields are written but
    // are not in the lockable schema, so they may be cleared by a re-extraction
    // (the edited.jpg has no EXIF) — acceptable for now.
    const lockedProperties: LockableProperty[] = ['dateTimeOriginal', 'timeZone', 'latitude', 'longitude'];
    await this.assetRepository.upsertExif(
      {
        assetId: asset.id,
        dateTimeOriginal: parent.dateTimeOriginal,
        timeZone: parent.timeZone,
        latitude: parent.latitude,
        longitude: parent.longitude,
        make: parent.make,
        model: parent.model,
        lensModel: parent.lensModel,
        fNumber: parent.fNumber,
        focalLength: parent.focalLength,
        iso: parent.iso,
        exposureTime: parent.exposureTime,
        lockedProperties,
      },
      { lockedPropertiesBehavior: 'append' },
    );

    this.logger.log(
      `Inherited metadata for edited asset ${asset.id} from parent ${parent.id} (distance ${parent.distance.toFixed(4)})`,
    );

    return JobStatus.Success;
  }
}
