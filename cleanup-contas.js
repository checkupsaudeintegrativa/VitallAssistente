/**
 * Limpa descrições e preenche categorias nas contas_pagar.
 * 1. Remove prefixos "Pagamento de Conta:", "Pagamento " do início das descrições
 * 2. Coloca todas as descrições em CAPS LOCK
 * 3. Usa GPT para inferir categoria das contas que não têm
 * Rode: node cleanup-contas.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai').default;

const sb  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const gpt = new OpenAI({ apiKey: process.env.OPENAI_FINANCIAL_API_KEY || process.env.OPENAI_API_KEY });

// Categorias padrão da clínica (normalizadas)
const CATEGORIAS_PADRAO = [
  'PRÓ-LABORE',
  'SALÁRIOS',
  'MATERIAL ODONTOLÓGICO',
  'LABORATÓRIO',
  'RADIOLOGIA',
  'IMPOSTOS',
  'INFRAESTRUTURA',
  'MARKETING',
  'MANUTENÇÃO',
  'LIMPEZA',
  'ALIMENTAÇÃO',
  'UTILIDADES',
  'TREINAMENTO',
  'ENCARGOS',
  'ALINHADORES',
  'DESPESAS GERAIS',
  'INVESTIMENTO',
  'OUTROS',
];

// ── Limpeza de descrição ──────────────────────────────────────────────────────

function cleanDescricao(desc) {
  if (!desc) return '';
  let d = desc.trim();
  // Remove prefixos variados (case-insensitive)
  d = d.replace(/^pagamento\s+de\s+conta:\s*/i, '');
  d = d.replace(/^pagamento\s+de\s+conta\s*/i, '');
  d = d.replace(/^pix\s+para\s+/i, '');
  // Remove "Pagamento " genérico apenas quando seguido de nome (mantém o nome)
  d = d.replace(/^pagamento\s+/i, '');
  // Remove pontuação solta no início
  d = d.replace(/^[:\-–\s]+/, '');
  // CAPS LOCK e trim
  return d.trim().toUpperCase();
}

// ── Inferência de categoria via GPT (batch) ───────────────────────────────────

async function inferirCategorias(contas, categoriasExistentes) {
  if (contas.length === 0) return [];

  const listaCategorias = [...new Set([...CATEGORIAS_PADRAO, ...categoriasExistentes])].sort().join(', ');

  const linhas = contas.map((c, i) =>
    `${i + 1}. desc="${c.descricao}" classificacao="${c.classificacao || ''}"`
  ).join('\n');

  const prompt = `Você é assistente financeiro de uma clínica odontológica (Vitall Odontologia).

Categorias disponíveis: ${listaCategorias}

Para cada conta abaixo, escolha UMA categoria da lista. Se nenhuma se encaixar, crie uma em CAPS LOCK (máximo 2 palavras).
Responda APENAS com JSON: [{"idx":1,"categoria":"..."},{"idx":2,"categoria":"..."},...]

Contas:
${linhas}`;

  const resp = await gpt.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  const raw = resp.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
    // Pode vir como { result: [...] } ou diretamente como array
    const arr = Array.isArray(parsed) ? parsed : (parsed.result || parsed.categorias || Object.values(parsed)[0]);
    return arr;
  } catch {
    console.warn('   ⚠️  Erro ao parsear resposta GPT:', raw.slice(0, 200));
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔍 Buscando todas as contas a pagar...\n');

  // Paginação para pegar todas (Supabase retorna max 1000 por query)
  let allContas = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from('contas_pagar')
      .select('id,descricao,categoria,classificacao')
      .order('id')
      .range(from, from + 499);
    if (error) { console.error('Erro:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    allContas.push(...data);
    if (data.length < 500) break;
    from += 500;
  }

  console.log(`📋 Total de contas: ${allContas.length}`);

  // ── 1. Limpeza de descrições ──
  console.log('\n🧹 Limpando descrições...');
  const atualizarDesc = [];

  for (const c of allContas) {
    const nova = cleanDescricao(c.descricao);
    if (nova !== c.descricao) {
      atualizarDesc.push({ id: c.id, descricao: nova });
    }
  }

  console.log(`   ${atualizarDesc.length} descrições para atualizar`);

  if (atualizarDesc.length > 0) {
    let ok = 0;
    for (const item of atualizarDesc) {
      const { error } = await sb.from('contas_pagar').update({ descricao: item.descricao }).eq('id', item.id);
      if (error) console.warn(`   ⚠️  Erro ao atualizar ${item.id}:`, error.message);
      else ok++;
    }
    console.log(`   ✅ ${ok} descrições atualizadas`);
  }

  // ── 2. Inferência de categorias ──
  const categoriasExistentes = [...new Set(allContas.map(c => c.categoria).filter(Boolean))];
  const semCategoria = allContas.filter(c => !c.categoria);

  // Atualiza objeto local com descrições limpas
  for (const item of atualizarDesc) {
    const c = allContas.find(x => x.id === item.id);
    if (c) c.descricao = item.descricao;
  }

  console.log(`\n🤖 Inferindo categorias para ${semCategoria.length} contas sem categoria...`);

  const BATCH = 50;
  const atualizarCateg = [];

  for (let i = 0; i < semCategoria.length; i += BATCH) {
    const batch = semCategoria.slice(i, i + BATCH);
    process.stdout.write(`   Batch ${Math.floor(i/BATCH)+1}/${Math.ceil(semCategoria.length/BATCH)}... `);

    const resultados = await inferirCategorias(batch, categoriasExistentes);

    for (const r of resultados) {
      const idx = r.idx - 1;
      if (idx >= 0 && idx < batch.length) {
        atualizarCateg.push({ id: batch[idx].id, categoria: r.categoria.toUpperCase() });
      }
    }
    console.log(`${resultados.length} categorizadas`);
    await new Promise(res => setTimeout(res, 300)); // rate limit
  }

  console.log(`\n   ${atualizarCateg.length} categorias para salvar`);

  if (atualizarCateg.length > 0) {
    let ok = 0;
    for (const item of atualizarCateg) {
      const { error } = await sb.from('contas_pagar').update({ categoria: item.categoria }).eq('id', item.id);
      if (error) console.warn(`   ⚠️  Erro ao atualizar ${item.id}:`, error.message);
      else ok++;
    }
    console.log(`   ✅ ${ok} categorias atualizadas`);
  }

  console.log('\n✨ Limpeza concluída!');
  console.log('   Agora as descrições estão em CAPS sem prefixos e todas têm categoria.');
}

main().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
