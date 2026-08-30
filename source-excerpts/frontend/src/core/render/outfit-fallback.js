// =====================================================================
// V22.4.4 — RESERVA DE OUTFIT PARA SPRITE VAZIA
//
// Algumas spritesheets do pacote de arte chegaram vazias (só pixels
// transparentes) ou nem existem — lookType 42 (Piccolo Reborn), 592
// (Goku Black Reborn) e 716 (Botamo Reborn Lv 2000), por exemplo. Quem
// transformasse para uma dessas formas simplesmente sumia da tela.
//
// Aqui a folha é checada uma vez, e a forma sem arte passa a usar a
// spritesheet da forma ANTERIOR da própria cadeia. É a mesma ideia do
// patchBlankMonsterOutfits do renderer da Hunt, só que para o jogador e
// resolvida sozinha: nada de lista fixa de lookTypes para manter.
// =====================================================================

// outfitId -> lista de reservas, da mais próxima para a mais distante.
const fallbackChains = new Map();

// src da folha -> 'ok' | 'blank' | 'error'. Sem entrada = ainda não dá
// para afirmar nada (imagem carregando).
const sheetState = new Map();

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  return canvas;
}

/**
 * Monta as cadeias de reserva a partir das formas de cada personagem.
 * Deve ser chamado uma vez, no boot, com o `characters` do game-content.
 */
export function registerFormChains(characters) {
  for (const character of Object.values(characters || {})) {
    const forms = character?.forms || [];
    for (let i = 0; i < forms.length; i += 1) {
      const outfitId = forms[i]?.outfitId;
      if (!outfitId) continue;
      const previous = [];
      for (let j = i - 1; j >= 0; j -= 1) {
        const id = forms[j]?.outfitId;
        if (id && id !== outfitId && !previous.includes(id)) previous.push(id);
      }
      // Por último o outfit base do personagem, que sempre existe.
      if (character.outfitId && character.outfitId !== outfitId &&
          !previous.includes(character.outfitId)) {
        previous.push(character.outfitId);
      }
      if (!previous.length) continue;
      const current = fallbackChains.get(outfitId);
      if (!current) {
        fallbackChains.set(outfitId, previous);
      } else {
        // Um mesmo outfitId pode aparecer em mais de uma vocação; junta as
        // reservas em vez de deixar a última sobrescrever a anterior.
        for (const id of previous) if (!current.includes(id)) current.push(id);
      }
    }
  }
}

/**
 * A folha tem algum pixel visível? Enquanto a imagem não terminou de
 * carregar responde `true` (otimista) — no quadro seguinte, já carregada,
 * a resposta vira definitiva e o desenho se corrige sozinho.
 */
export function sheetUsable(image) {
  if (!image) return false;
  const src = image.src || '';
  const known = sheetState.get(src);
  if (known) return known === 'ok';
  if (!image.complete) return true;
  if (!image.naturalWidth) { sheetState.set(src, 'error'); return false; }

  try {
    const canvas = makeCanvas(image.naturalWidth, image.naturalHeight);
    const ctx = canvas.getContext('2d', { willReadFrequently:true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 16 && ++visible > 24) break;
    }
    const state = visible > 24 ? 'ok' : 'blank';
    sheetState.set(src, state);
    return state === 'ok';
  } catch {
    // Canvas de outra origem: não dá para inspecionar, então confia.
    sheetState.set(src, 'ok');
    return true;
  }
}

/**
 * Devolve o primeiro outfit da cadeia que tenha arte de verdade.
 *
 * @param {string} outfitId    o outfit pedido pela forma atual
 * @param {object} outfits     manifesto de outfits (id -> entrada)
 * @param {function} loadImage função do renderer que devolve a Image do src
 * @returns {{outfitId, outfit, image, borrowedFrom}|null}
 */
export function resolveOutfit(outfitId, outfits, loadImage) {
  if (!outfitId || !outfits) return null;
  const chain = [outfitId, ...(fallbackChains.get(outfitId) || [])];
  let first = null;

  for (const id of chain) {
    let outfit = outfits[id];
    const wodboMatch = /^wodbo-(\d+)$/.exec(String(id));
    if (!outfit && wodboMatch) {
      const lookType = Number(wodboMatch[1]);
      outfit = {
        lookType,
        src:`./assets/generated/wodbo-vocations/outfits/${lookType}.png?v=22.4.4`,
        portrait:`./assets/generated/wodbo-vocations/portraits/${lookType}.png?v=22.4.4`,
        frameWidth:32,
        frameHeight:64,
        directions:4,
        frames:3,
        frameMs:150,
        idleFrame:0,
        walkFrames:[0, 1, 2],
        directionOrder:['north', 'east', 'south', 'west'],
        directionRows:[0, 1, 2, 3]
      };
    }
    if (!outfit?.src) continue;
    const image = loadImage(outfit.src);
    const candidate = { outfitId:id, outfit, image, borrowedFrom:id === outfitId ? null : outfitId };
    if (!first) first = candidate;
    if (sheetUsable(image)) return candidate;
  }
  // Nenhuma folha utilizável: devolve a primeira mesmo assim, para o
  // resto do desenho (nome, sombra, barra) continuar no lugar.
  return first;
}

export function outfitFallbackDebug() {
  return {
    chains: fallbackChains.size,
    blank: [...sheetState.entries()].filter(([, v]) => v !== 'ok').map(([k]) => k)
  };
}
