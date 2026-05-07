<script lang="ts">
  import { handleError } from '$lib/utils/handle-error';
  import { identifyAssetSubject, type AssetResponseDto, type IdentifyResultDto } from '@immich/sdk';
  import { Button, Icon, LoadingSpinner } from '@immich/ui';
  import { mdiLeaf } from '@mdi/js';

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();

  let results: IdentifyResultDto[] = $state([]);
  let loading = $state(false);
  let ran = $state(false);

  const iconicTaxonIcon: Record<string, string> = {
    Plantae: '🌿',
    Fungi: '🍄',
    Aves: '🐦',
    Mammalia: '🐾',
    Reptilia: '🦎',
    Amphibia: '🐸',
    Actinopterygii: '🐟',
    Insecta: '🐛',
    Arachnida: '🕷️',
    Mollusca: '🐚',
  };

  const taxonLabel = (name: string) => iconicTaxonIcon[name] ?? '🔬';

  const handleIdentify = async () => {
    loading = true;
    try {
      const response = await identifyAssetSubject({ id: asset.id });
      results = response.results;
      ran = true;
    } catch (error) {
      handleError(error, 'Failed to identify subject');
    } finally {
      loading = false;
    }
  };
</script>

<section class="px-4 mt-4">
  <div class="flex h-10 w-full items-center justify-between text-sm">
    <div class="flex items-center gap-2 text-gray-500 dark:text-gray-400">
      <Icon icon={mdiLeaf} size="18" />
      <span class="text-sm">Identify Subject</span>
    </div>
    <Button
      size="small"
      color="secondary"
      variant="ghost"
      shape="round"
      onclick={handleIdentify}
      disabled={loading}
    >
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
    <div class="mt-2 flex flex-col gap-2">
      {#each results as result, i (result.scientificName)}
        <div
          class="flex gap-3 items-start rounded-lg p-2 {i === 0
            ? 'bg-primary-50 dark:bg-primary-950/30 border border-primary-200 dark:border-primary-800'
            : 'opacity-70'}"
        >
          {#if result.photoUrl}
            <img
              src={result.photoUrl}
              alt={result.scientificName}
              class="w-12 h-12 rounded object-cover flex-shrink-0"
            />
          {:else}
            <div class="w-12 h-12 rounded bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-2xl flex-shrink-0">
              {taxonLabel(result.iconicTaxon)}
            </div>
          {/if}

          <div class="flex-1 min-w-0">
            <p class="font-medium text-sm truncate">
              {result.commonName ?? result.scientificName}
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400 italic truncate">
              {result.scientificName}
            </p>
            <div class="flex items-center gap-2 mt-1">
              <span class="text-xs text-gray-400">{taxonLabel(result.iconicTaxon)} {result.iconicTaxon}</span>
              <span class="text-xs text-gray-400">{Math.round(result.score * 100)}%</span>
              {#if result.wikiUrl}
                <a
                  href={result.wikiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs text-primary-600 dark:text-primary-400 hover:underline"
                >
                  Wikipedia ↗
                </a>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>
