export function vuepressConfig(base: string, title: string, language: string): string {
  const french = language.toLowerCase().startsWith('fr');
  const labels = french ? {
    toggleSidebar: 'Afficher le sommaire', toggleDarkMode: 'Changer le thème',
    openInNewWindow: 'Ouvrir dans une nouvelle fenêtre', backToHome: 'Retour au document',
    notFound: ['Cette page est introuvable.'], lastUpdatedText: 'Mis à jour',
    contributorsText: 'Contributeurs', tip: 'Conseil', warning: 'Attention', danger: 'Important',
  } : {};
  return `import { defineUserConfig } from 'vuepress';
import { viteBundler } from '@vuepress/bundler-vite';
import { defaultTheme } from '@vuepress/theme-default';
import { markdownChartPlugin } from '@vuepress/plugin-markdown-chart';

export default defineUserConfig({
  base: ${JSON.stringify(base)},
  lang: ${JSON.stringify(language)},
  title: ${JSON.stringify(title)},
  pagePatterns: ['README.md'],
  shouldPrefetch: false,
  bundler: viteBundler({ viteOptions: { ssr: { noExternal: [/^@vuepress\\//] } } }),
  theme: defaultTheme({
    colorMode: 'light', colorModeSwitch: false,
    navbar: [], sidebar: 'heading',
    editLink: false, lastUpdated: false, contributors: false,
    themePlugins: { git: false },
    ...${JSON.stringify(labels)},
  }),
  markdown: {
    html: false, component: false, frontmatter: false,
    importCode: false, assets: false,
    links: false,
  },
  extendsMarkdown(md) { md.set({ html: false }); },
  plugins: [markdownChartPlugin({ mermaid: true })],
});
`;
}

export function clientConfig(language: string): string { return `import { defineClientConfig } from 'vuepress/client';
import { defineMermaidConfig } from '@vuepress/plugin-markdown-chart/client';
import { onMounted, onUnmounted } from 'vue';

defineMermaidConfig({
  theme: 'neutral',
  securityLevel: 'strict',
  startOnLoad: false,
  flowchart: { htmlLabels: false },
});

export default defineClientConfig({
  setup() {
    let observer;
    onMounted(() => {
      if (!${JSON.stringify(language)}.toLowerCase().startsWith('fr')) return;
      const translate = () => {
        for (const element of document.querySelectorAll('.mermaid-actions [title], .mermaid-actions [aria-label]')) {
          for (const attribute of ['title', 'aria-label']) {
            const text = element.getAttribute(attribute);
            const replacement = { preview: 'Aperçu du diagramme', download: 'Télécharger le diagramme' }[text?.toLowerCase()];
            if (replacement) {
              element.setAttribute(attribute, replacement);
              element.setAttribute('aria-label', replacement);
            }
          }
        }
      };
      translate();
      observer = new MutationObserver(translate);
      observer.observe(document.body, { childList: true, subtree: true });
    });
    onUnmounted(() => observer?.disconnect());
  },
});
`; }
