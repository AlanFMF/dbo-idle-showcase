const DEFAULT_INDEX_URL = './generated/asset-registry/index.json';

export class AssetRegistry {
  constructor(indexUrl = DEFAULT_INDEX_URL) {
    this.indexUrl = indexUrl;
    this.index = null;
    this.categories = new Map();
    this.itemIdMap = null;
  }

  async initialize() {
    if (this.index) return this;
    const response = await fetch(this.indexUrl);
    if (!response.ok) {
      throw new Error(`AssetRegistry indisponível: ${response.status}`);
    }
    this.index = await response.json();
    return this;
  }

  async loadCategory(category) {
    await this.initialize();
    const key = category.endsWith('s') ? category : `${category}s`;
    if (this.categories.has(key)) return this.categories.get(key);

    const url = this.index.registries[key];
    if (!url) throw new Error(`Categoria desconhecida: ${category}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Falha ao carregar ${key}: ${response.status}`);
    }

    const entries = await response.json();
    const result = {
      entries,
      byId:new Map(entries.map(entry => [
        Number(entry.clientId),
        entry
      ]))
    };
    this.categories.set(key, result);
    return result;
  }

  async get(category, clientId) {
    const loaded = await this.loadCategory(category);
    return loaded.byId.get(Number(clientId)) || null;
  }

  async loadItemIdMap() {
    await this.initialize();
    if (this.itemIdMap) return this.itemIdMap;

    const response = await fetch(this.index.registries.itemIdMap);
    if (!response.ok) {
      throw new Error(`Falha ao carregar o mapa OTB: ${response.status}`);
    }
    this.itemIdMap = await response.json();
    return this.itemIdMap;
  }

  async itemByServerId(serverId) {
    const mapping = await this.loadItemIdMap();
    const clientId =
      mapping.serverToClient[String(Number(serverId))];
    return clientId ? this.get('item', clientId) : null;
  }

  cell(entry, options = {}) {
    if (!entry) return null;
    const patternX = Number(options.patternX || 0);
    const patternY = Number(options.patternY || 0);
    const patternZ = Number(options.patternZ || 0);
    const frame = Number(options.frame || 0);

    return entry.cells.find(cell =>
      cell.patternX === patternX &&
      cell.patternY === patternY &&
      cell.patternZ === patternZ &&
      cell.frame === frame
    ) || entry.cells[0] || null;
  }

  cropStyle(entry, options = {}) {
    const cell = this.cell(entry, options);
    if (!entry || !cell) return null;

    return {
      backgroundImage:`url("${entry.sheet}")`,
      backgroundPosition:`-${cell.x}px -${cell.y}px`,
      backgroundSize:
        `${entry.sheetColumns * entry.pixelWidth}px ` +
        `${entry.sheetRows * entry.pixelHeight}px`,
      width:`${entry.pixelWidth}px`,
      height:`${entry.pixelHeight}px`,
      imageRendering:'pixelated'
    };
  }
}

export const assetRegistry = new AssetRegistry();
