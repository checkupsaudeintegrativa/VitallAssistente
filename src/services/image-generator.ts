import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { ChartConfiguration } from 'chart.js';
import { createCanvas } from 'canvas';

// ── Paleta de cores Vitall ──

const VITALL_COLORS = [
  '#3B82F6', // azul
  '#10B981', // verde
  '#EF4444', // vermelho
  '#F59E0B', // amber
  '#8B5CF6', // violeta
  '#EC4899', // rosa
  '#06B6D4', // ciano
  '#F97316', // laranja
  '#6366F1', // indigo
  '#14B8A6', // teal
];

const VITALL_BG_COLORS = VITALL_COLORS.map((c) => c + '99'); // 60% opacity

// ── Chart.js Canvas (singleton lazy-init) ──

let chartCanvas: ChartJSNodeCanvas | null = null;

function getChartCanvas(): ChartJSNodeCanvas {
  if (!chartCanvas) {
    chartCanvas = new ChartJSNodeCanvas({
      width: 800,
      height: 600,
      backgroundColour: '#FFFFFF',
    });
  }
  return chartCanvas;
}

/** Aplica defaults visuais Vitall ao config do chart */
function applyChartDefaults(config: ChartConfiguration): ChartConfiguration {
  // Desabilita animações (não faz sentido para imagem estática)
  config.options = config.options || {};
  config.options.animation = false;

  // Cores padrão se datasets não tiver cores
  if (config.data?.datasets) {
    for (const ds of config.data.datasets) {
      if (!ds.backgroundColor) {
        ds.backgroundColor = config.type === 'pie' || config.type === 'doughnut'
          ? VITALL_BG_COLORS
          : VITALL_BG_COLORS[0];
      }
      if (!ds.borderColor) {
        ds.borderColor = config.type === 'pie' || config.type === 'doughnut'
          ? VITALL_COLORS
          : VITALL_COLORS[0];
      }
      if ((ds as any).borderWidth === undefined) {
        (ds as any).borderWidth = config.type === 'pie' || config.type === 'doughnut' ? 2 : 2;
      }
    }
  }

  // Fonte padrão
  config.options.font = { family: 'Arial, sans-serif', size: 14 };

  // Plugin title styling
  config.options.plugins = config.options.plugins || {};
  if (config.options.plugins.title) {
    config.options.plugins.title.font = { size: 18, weight: 'bold' };
    config.options.plugins.title.color = '#1F2937';
  }

  // Legend styling
  config.options.plugins.legend = config.options.plugins.legend || {};
  config.options.plugins.legend.labels = config.options.plugins.legend.labels || {};
  config.options.plugins.legend.labels.color = '#374151';

  return config;
}

/**
 * Renderiza um gráfico Chart.js para PNG buffer.
 * A IA envia o config completo — máxima flexibilidade.
 */
export async function renderChart(chartConfig: ChartConfiguration): Promise<Buffer> {
  const canvas = getChartCanvas();
  const config = applyChartDefaults(chartConfig);
  return canvas.renderToBuffer(config);
}

// ── Card Visual ──

interface CardField {
  label: string;
  value: string;
}

interface CardOptions {
  title: string;
  fields: CardField[];
  footer?: string;
  color?: string; // cor da barra do título (default: azul Vitall)
}

/**
 * Renderiza um card visual (recibo, resumo) para PNG buffer.
 * Layout: barra título colorida → rows alternadas → footer → branding.
 */
export async function renderCard(options: CardOptions): Promise<Buffer> {
  const { title, fields, footer, color = '#3B82F6' } = options;

  const WIDTH = 600;
  const PADDING = 24;
  const TITLE_HEIGHT = 56;
  const ROW_HEIGHT = 40;
  const FOOTER_HEIGHT = footer ? 44 : 0;
  const BRANDING_HEIGHT = 32;
  const TOTAL_HEIGHT = TITLE_HEIGHT + fields.length * ROW_HEIGHT + FOOTER_HEIGHT + BRANDING_HEIGHT + PADDING;

  const canvas = createCanvas(WIDTH, TOTAL_HEIGHT);
  const ctx = canvas.getContext('2d');

  // Background branco
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, WIDTH, TOTAL_HEIGHT);

  // Barra do título
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, WIDTH, TITLE_HEIGHT);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 20px Arial';
  ctx.fillText(title, PADDING, 36);

  // Rows alternadas
  let y = TITLE_HEIGHT;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];

    // Background alternado
    ctx.fillStyle = i % 2 === 0 ? '#F9FAFB' : '#FFFFFF';
    ctx.fillRect(0, y, WIDTH, ROW_HEIGHT);

    // Label
    ctx.fillStyle = '#6B7280';
    ctx.font = '14px Arial';
    ctx.fillText(field.label, PADDING, y + 26);

    // Value (alinhado à direita)
    ctx.fillStyle = '#1F2937';
    ctx.font = 'bold 14px Arial';
    const valueWidth = ctx.measureText(field.value).width;
    ctx.fillText(field.value, WIDTH - PADDING - valueWidth, y + 26);

    y += ROW_HEIGHT;
  }

  // Footer
  if (footer) {
    ctx.fillStyle = '#F3F4F6';
    ctx.fillRect(0, y, WIDTH, FOOTER_HEIGHT);
    ctx.fillStyle = '#6B7280';
    ctx.font = '13px Arial';
    ctx.fillText(footer, PADDING, y + 28);
    y += FOOTER_HEIGHT;
  }

  // Branding
  ctx.fillStyle = '#E5E7EB';
  ctx.fillRect(0, y, WIDTH, BRANDING_HEIGHT);
  ctx.fillStyle = '#9CA3AF';
  ctx.font = '11px Arial';
  const brandText = 'Vitall Odontologia';
  const brandWidth = ctx.measureText(brandText).width;
  ctx.fillText(brandText, WIDTH - PADDING - brandWidth, y + 21);

  return canvas.toBuffer('image/png');
}
