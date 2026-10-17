<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useData } from "vitepress";

const props = defineProps<{ code: string }>();
const source = computed(() => decodeURIComponent(props.code));
const { isDark } = useData();
const host = ref<HTMLElement>();
let counter = 0;

async function render(): Promise<void> {
  if (!host.value) return;
  try {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: isDark.value ? "dark" : "neutral",
      fontFamily: "var(--vp-font-family-base)",
    });
    const { svg } = await mermaid.render(`kestrel-mermaid-${++counter}`, source.value);
    if (host.value) host.value.innerHTML = svg;
  } catch (error) {
    if (host.value) {
      host.value.textContent = `Diagram error: ${error instanceof Error ? error.message : String(error)}`;
      host.value.classList.add("mermaid-diagram--error");
    }
  }
}

onMounted(render);
watch(source, render);
watch(isDark, render);
</script>

<template>
  <div ref="host" class="mermaid-diagram" role="img" :aria-label="source.split('\n')[0]" />
</template>
