<script lang="ts">
  import { handleError } from '$lib/utils/handle-error';
  import {
    bulkTagAssets,
    getAssetMetadataByKey,
    identifyAssetSubject,
    updateAssetMetadata,
    upsertTags,
    type AssetResponseDto,
    type IdentifyResultDto,
  } from '@immich/sdk';
  import { Button, Icon, LoadingSpinner } from '@immich/ui';
  import { mdiLeaf } from '@mdi/js';

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset = $bindable() }: Props = $props();

  let results: IdentifyResultDto[] = $state([]);
  let selectedIndex = $state(0);
  let loading = $state(false);
  let saving = $state(false);
  let ran = $state(false);

  const iconicTaxonIcon: Record<string, string> = {
    Plantae: '🌿', Fungi: '🍄', Aves: '🐦', Mammalia: '🐾',
    Reptilia: '🦎', Amphibia: '🐸', Actinopterygii: '🐟',
    Insecta: '🐛', Arachnida: '🕷️', Mollusca: '🐚',
  };
  const taxonLabel = (name: string) => iconicTaxonIcon[name] ?? '🔬';
  const formatScore = (score: number) =>
    `${Math.min(100, Math.round(score > 1 ? score : score * 100))}%`;

  // Load saved species on mount
  $effect(() => {
    getAssetMetadataByKey({ id: asset.id, key: 'species' })
      .then((meta) => {
        const saved = meta.value as unknown as IdentifyResultDto;
        if (saved?.scientificName) {
          results = [saved];
          selectedIndex = 0;
          ran = true;
        }
      })
      .catch(() => {
        // no saved species yet — that's fine
      });
  });

  const saveSelection = async (index: number) => {
    const result = results[index];
    await updateAssetMetadata({
      id: asset.id,
      assetMetadataUpsertDto: { items: [{ key: 'species', value: result as unknown as object }] },
    });
    // Upsert tag e.g. "species/Blue Jay" and apply to this asset
    const tagValue = `species/${result.commonName ?? result.scientificName}`;
    const [tag] = await upsertTags({ tagUpsertDto: { tags: [tagValue] } });
    if (tag) {
      await bulkTagAssets({ tagBulkAssetsDto: { tagIds: [tag.id], assetIds: [asset.id] } });
    }
  };

  const handleIdentify = async () => {
    loading = true;
    try {
      const response = await identifyAssetSubject({ id: asset.id });
      results = response.results;
      selectedIndex = 0;
      ran = true;
      // Top result is already saved server-side; also tag it
      if (results.length > 0) {
        const tagValue = `species/${results[0].commonName ?? results[0].scientificName}`;
        const [tag] = await upsertTags({ tagUpsertDto: { tags: [tagValue] } });
        if (tag) {
          await bulkTagAssets({ tagBulkAssetsDto: { tagIds: [tag.id], assetIds: [asset.id] } });
        }
      }
    } catch (error) {
      handleError(error, 'Failed to identify subject');
    } finally {
      loading = false;
    }
  };

  const handleSelect = async (index: number) => {
    if (index === selectedIndex || saving) return;
    saving = true;
    try {
      await saveSelection(index);
      selectedIndex = index;
    } catch (error) {
      handleError(error, 'Failed to save selection');
    } finally {
      saving = false;
    }
  };
</script>

<section class="px-4 mt-4">
  <div class="flex h-10 w-full items-center justify-between text-sm">
    <div class="flex items-center gap-2 text-gray-500 dark:text-gray-400">
      <Icon icon={mdiLeaf} size="18" />
      <span class="text-sm">Identify Subject</span>
    </div>
    <Button size="small" color="secondary" variant="ghost" shape="round" onclick={handleIdentify} disabled={loading || saving}>
      {#if loading}
        <LoadingSpinner />
      {:else if ran}
        Re-identify
      {:else}
        Identify
      {/if}
    </Button>
  </div>

  {#if results.length > 0}
    <div class="mt-2 flex flex-col gap-1">
      {#each results as result, i (result.scientificName)}
        {@const isSelected = i === selectedIndex}
        <button
          type="button"
          class="flex gap-3 items-start rounded-lg p-2 w-full text-left transition-opacity
            {isSelected
              ? 'bg-primary-50 dark:bg-primary-950/30 border border-primary-200 dark:border-primary-800'
              : 'opacity-50 hover:opacity-100 hover:bg-gray-100 dark:hover:bg-gray-800/50 border border-transparent'}
            {saving ? 'cursor-wait' : 'cursor-pointer'}"
          onclick={() => handleSelect(i)}
          disabled={saving}
        >
          {#if result.photoUrl}
            <img src={result.photoUrl} alt={result.scientificName} class="w-12 h-12 rounded object-cover flex-shrink-0" />
          {:else}
            <div class="w-12 h-12 rounded bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-2xl flex-shrink-0">
              {taxonLabel(result.iconicTaxon)}
            </div>
          {/if}
          <div class="flex-1 min-w-0">
            <p class="font-medium text-sm truncate">{result.commonName ?? result.scientificName}</p>
            <p class="text-xs text-gray-500 dark:text-gray-400 italic truncate">{result.scientificName}</p>
            <div class="flex items-center gap-2 mt-1">
              <span class="text-xs text-gray-400">{taxonLabel(result.iconicTaxon)} {result.iconicTaxon}</span>
              <span class="text-xs text-gray-400">{formatScore(result.score)}</span>
              {#if result.wikiUrl}
                <a
                  href={result.wikiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs text-primary-600 dark:text-primary-400 hover:underline"
                  onclick={(e) => e.stopPropagation()}
                >Wikipedia ↗</a>
              {/if}
            </div>
          </div>
        </button>
      {/each}
    </div>
    {#if results.length > 1}
      <p class="text-xs text-gray-400 mt-1 px-1">Tap a result to save it as this photo's subject</p>
    {/if}
  {/if}
</section>
