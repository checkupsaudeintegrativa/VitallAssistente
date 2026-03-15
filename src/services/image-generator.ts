import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { ChartConfiguration } from 'chart.js';
import { createCanvas, registerFont, loadImage } from 'canvas';
import * as path from 'path';

// ── Registrar fontes DM Sans (bundled TTF) ──

const ASSETS_DIR = path.resolve(__dirname, '..', '..', 'assets');

try {
  registerFont(path.join(ASSETS_DIR, 'DMSans-Regular.ttf'), { family: 'DMSans' });
  registerFont(path.join(ASSETS_DIR, 'DMSans-Bold.ttf'), { family: 'DMSans', weight: 'bold' });
} catch (err: any) {
  console.warn('[ImageGen] Não foi possível registrar fontes DM Sans:', err.message);
}

const FONT_FAMILY = 'DMSans';
const LOGO_PATH = path.join(ASSETS_DIR, 'vitall-logo.png');

// ── Paleta de cores Vitall (teal-based) ──

const VITALL_PRIMARY = '#0d9488';   // teal-600
const VITALL_PRIMARY_DARK = '#0f766e'; // teal-700
const VITALL_PRIMARY_LIGHT = '#ccfbf1'; // teal-100

const VITALL_COLORS = [
  '#0d9488', // teal-600 (primary)
  '#14b8a6', // teal-500
  '#f59e0b', // amber-500
  '#3b82f6', // blue-500
  '#8b5cf6', // violet-500
  '#ef4444', // red-500
  '#ec4899', // pink-500
  '#f97316', // orange-500
  '#06b6d4', // cyan-500
  '#6366f1', // indigo-500
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
      chartCallback: (ChartJS) => {
        ChartJS.defaults.font.family = FONT_FAMILY;
      },
    });
  }
  return chartCanvas;
}

/** Aplica defaults visuais Vitall ao config do chart */
function applyChartDefaults(config: ChartConfiguration): ChartConfiguration {
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
        (ds as any).borderWidth = 2;
      }
    }
  }

  // Fonte padrão
  config.options.font = { family: FONT_FAMILY, size: 14 };

  // Plugin title styling
  config.options.plugins = config.options.plugins || {};
  if (config.options.plugins.title) {
    config.options.plugins.title.font = { size: 18, weight: 'bold', family: FONT_FAMILY };
    config.options.plugins.title.color = '#1F2937';
  }

  // Legend styling
  config.options.plugins.legend = config.options.plugins.legend || {};
  config.options.plugins.legend.labels = config.options.plugins.legend.labels || {};
  config.options.plugins.legend.labels.color = '#374151';
  config.options.plugins.legend.labels.font = { family: FONT_FAMILY };

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
  color?: string;
}

/**
 * Renderiza um card visual (recibo, resumo) para PNG buffer.
 * Layout: header teal com logo → rows alternadas → footer → branding com logo.
 */
export async function renderCard(options: CardOptions): Promise<Buffer> {
  const { title, fields, footer, color = VITALL_PRIMARY } = options;

  const WIDTH = 600;
  const PADDING = 28;
  const HEADER_HEIGHT = 64;
  const ROW_HEIGHT = 44;
  const DIVIDER = 1;
  const FOOTER_HEIGHT = footer ? 48 : 0;
  const BRANDING_HEIGHT = 52;
  const TOTAL_HEIGHT = HEADER_HEIGHT + fields.length * (ROW_HEIGHT + DIVIDER) + FOOTER_HEIGHT + BRANDING_HEIGHT + 16;

  const canvas = createCanvas(WIDTH, TOTAL_HEIGHT);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, WIDTH, TOTAL_HEIGHT);

  // Borda esquerda colorida (accent bar)
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 5, TOTAL_HEIGHT);

  // Header
  ctx.fillStyle = color;
  ctx.fillRect(5, 0, WIDTH - 5, HEADER_HEIGHT);

  // Título
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold 20px "${FONT_FAMILY}"`;
  ctx.fillText(title, PADDING + 4, 40);

  // Rows
  let y = HEADER_HEIGHT;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];

    // Background alternado
    ctx.fillStyle = i % 2 === 0 ? '#f0fdfa' : '#FFFFFF'; // teal-50 / white
    ctx.fillRect(5, y, WIDTH - 5, ROW_HEIGHT);

    // Linha divisória sutil
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(PADDING, y + ROW_HEIGHT, WIDTH - PADDING * 2, DIVIDER);

    // Label
    ctx.fillStyle = '#64748b';
    ctx.font = `14px "${FONT_FAMILY}"`;
    ctx.fillText(field.label, PADDING + 4, y + 28);

    // Value (alinhado à direita)
    ctx.fillStyle = '#0f172a';
    ctx.font = `bold 15px "${FONT_FAMILY}"`;
    const valueWidth = ctx.measureText(field.value).width;
    ctx.fillText(field.value, WIDTH - PADDING - valueWidth, y + 28);

    y += ROW_HEIGHT + DIVIDER;
  }

  // Footer
  if (footer) {
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(5, y, WIDTH - 5, FOOTER_HEIGHT);
    ctx.fillStyle = '#94a3b8';
    ctx.font = `13px "${FONT_FAMILY}"`;
    ctx.fillText(footer, PADDING + 4, y + 30);
    y += FOOTER_HEIGHT;
  }

  // Branding bar com logo
  ctx.fillStyle = '#f0fdfa'; // teal-50
  ctx.fillRect(5, y, WIDTH - 5, BRANDING_HEIGHT);

  // Tenta carregar e desenhar a logo
  try {
    const logo = await loadImage(LOGO_PATH);
    const logoH = 32;
    const logoW = (logo.width / logo.height) * logoH;
    ctx.drawImage(logo, WIDTH - PADDING - logoW, y + (BRANDING_HEIGHT - logoH) / 2, logoW, logoH);
  } catch {
    // Fallback: texto
    ctx.fillStyle = VITALL_PRIMARY;
    ctx.font = `bold 12px "${FONT_FAMILY}"`;
    const brandText = 'Vitall Odontologia';
    const brandWidth = ctx.measureText(brandText).width;
    ctx.fillText(brandText, WIDTH - PADDING - brandWidth, y + 32);
  }

  return canvas.toBuffer('image/png');
}

// ── Confirmação de Lembrete ──

/**
 * Renderiza imagem de confirmação de lembrete (600×300).
 * Layout: fundo branco, borda teal, checkmark verde, título + horário, logo Vitall.
 */
export async function renderReminderConfirmation(title: string, datetime: string): Promise<Buffer> {
  const WIDTH = 600;
  const HEIGHT = 300;

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  // Fundo branco
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Borda esquerda teal (accent bar)
  ctx.fillStyle = VITALL_PRIMARY;
  ctx.fillRect(0, 0, 5, HEIGHT);

  // Barra superior teal
  ctx.fillStyle = VITALL_PRIMARY;
  ctx.fillRect(5, 0, WIDTH - 5, 6);

  // ── Checkmark (círculo teal + check branco) ──
  const circleX = 80;
  const circleY = 120;
  const circleR = 38;

  // Sombra sutil
  ctx.fillStyle = 'rgba(13, 148, 136, 0.15)';
  ctx.beginPath();
  ctx.arc(circleX, circleY + 3, circleR + 4, 0, Math.PI * 2);
  ctx.fill();

  // Círculo teal
  ctx.fillStyle = VITALL_PRIMARY;
  ctx.beginPath();
  ctx.arc(circleX, circleY, circleR, 0, Math.PI * 2);
  ctx.fill();

  // Check branco (path)
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(circleX - 16, circleY + 2);
  ctx.lineTo(circleX - 4, circleY + 14);
  ctx.lineTo(circleX + 18, circleY - 12);
  ctx.stroke();

  // ── Textos ──
  const textX = 140;

  // "Lembrete criado!"
  ctx.fillStyle = '#0f172a'; // slate-900
  ctx.font = `bold 26px "${FONT_FAMILY}"`;
  ctx.fillText('Lembrete criado!', textX, 108);

  // Título do lembrete
  ctx.fillStyle = '#334155'; // slate-700
  ctx.font = `18px "${FONT_FAMILY}"`;
  const truncTitle = title.length > 40 ? title.substring(0, 37) + '...' : title;
  ctx.fillText(truncTitle, textX, 145);

  // Horário formatado
  const remindDate = new Date(datetime);
  const horarioStr = remindDate.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Ícone de relógio (texto) + horário
  ctx.fillStyle = VITALL_PRIMARY;
  ctx.font = `bold 16px "${FONT_FAMILY}"`;
  ctx.fillText(`🕐  ${horarioStr}`, textX, 180);

  // ── Branding bar inferior ──
  ctx.fillStyle = '#f0fdfa'; // teal-50
  ctx.fillRect(5, HEIGHT - 50, WIDTH - 5, 50);

  // Linha separadora
  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(5, HEIGHT - 50, WIDTH - 5, 1);

  // Logo Vitall
  try {
    const logo = await loadImage(LOGO_PATH);
    const logoH = 28;
    const logoW = (logo.width / logo.height) * logoH;
    ctx.drawImage(logo, WIDTH - 28 - logoW, HEIGHT - 39, logoW, logoH);
  } catch {
    ctx.fillStyle = VITALL_PRIMARY;
    ctx.font = `bold 12px "${FONT_FAMILY}"`;
    const brandText = 'Vitall Odontologia';
    const brandWidth = ctx.measureText(brandText).width;
    ctx.fillText(brandText, WIDTH - 28 - brandWidth, HEIGHT - 20);
  }

  return canvas.toBuffer('image/png');
}
