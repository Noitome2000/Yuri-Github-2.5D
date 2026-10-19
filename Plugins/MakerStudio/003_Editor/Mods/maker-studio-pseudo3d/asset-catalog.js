export const DEFAULT_CATEGORIES = ['建筑', '室内家具', '山体与岩石', '植被', '道路与围栏', '设施与标识', '图片立牌', '未分类'];

export function assetCategory(asset) {
  if (asset.category?.trim()) return asset.category.trim();
  if (asset.type === 'billboard') return '图片立牌';
  const name = `${asset.name || ''} ${asset.sourceObj || ''}`.toLowerCase();
  if (/rock|boulder|hill|cliff|mountain|cave|山|岩/.test(name)) return '山体与岩石';
  if (/plant|tree|grass|植|树/.test(name)) return '植被';
  if (/fence|rail|road|围栏|道路/.test(name)) return '道路与围栏';
  if (/interior|indoor|counter|table|shelf|bookcase|bed|fridge|sink|家具/.test(name)) return '室内家具';
  if (/lamp|sign|mailbox|fountain|healmachine|标识/.test(name)) return '设施与标识';
  if (/house|apartment|hall|tower|station|windmill|library|restaurant|pkmn|gamecorner|建筑/.test(name)) return '建筑';
  return '未分类';
}

export function catalogCategories(assets,folders=[]) {
  return [...new Set([...DEFAULT_CATEGORIES, ...assets.map(assetCategory),...folders.map(f=>f.category)])];
}

export function filterAssets(assets, {query = '', category = '', type = 'all', favorites = false} = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return assets.filter(a => (!category || assetCategory(a) === category) &&
    (type === 'all' || a.type === type) && (!favorites || a.favorite) &&
    terms.every(t => `${a.name} ${assetCategory(a)} ${(a.tags || []).join(' ')} ${a.sourceObj || ''}`.toLocaleLowerCase().includes(t)))
    .sort((a,b) => a.name.localeCompare(b.name, 'zh-CN', {numeric:true}));
}
