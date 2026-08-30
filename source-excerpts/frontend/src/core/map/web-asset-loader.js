let cachedStatus;
export async function loadWebAssetStatus(){
  if(cachedStatus) return cachedStatus;
  const response=await fetch('./generated/web/build-status.json',{cache:'no-store'});
  cachedStatus=await response.json();
  return cachedStatus;
}
export async function loadWebManifest(){
  const status=await loadWebAssetStatus();
  if(!status.ok) throw new Error(status.error||'Pipeline gráfico ainda não concluído.');
  const response=await fetch('./generated/web/manifest.json');
  if(!response.ok) throw new Error('Manifesto gráfico não encontrado.');
  return response.json();
}
