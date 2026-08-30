import { inventoryContainers } from './containers.js';

export function unlockedItemQuantity(state,itemId){
  itemId=String(itemId||'');
  return inventoryContainers(state).reduce((total,container)=>
    total+(container.items||[])
      .filter(entry=>String(entry.itemId)===itemId&&!entry.locked)
      .reduce((sum,entry)=>sum+Number(entry.quantity||0),0),0
  );
}

export function removeUnlockedMany(state,itemId,quantity){
  itemId=String(itemId||'');
  let remaining=Math.max(0,Math.trunc(Number(quantity)||0));
  for(const container of inventoryContainers(state)){
    for(let index=(container.items||[]).length-1;index>=0&&remaining>0;index--){
      const entry=container.items[index];
      if(String(entry?.itemId)!==itemId||entry.locked||entry.containerId)continue;
      const take=Math.min(remaining,Math.max(0,Math.trunc(Number(entry.quantity)||0)));
      if(take<=0)continue;
      entry.quantity=Number(entry.quantity||0)-take;
      remaining-=take;
      if(entry.quantity<=0)container.items.splice(index,1);
    }
  }
  return remaining===0;
}

export function toggleItemLock(state,containerId,index,expectedItemId=null,expectedInstanceId=null){
  const container=state?.containers?.[String(containerId||'')];
  if(!container)return {ok:false,message:'Item nao encontrado.'};
  index=Math.trunc(Number(index));
  const expected=expectedItemId==null?'':String(expectedItemId);
  const expectedInstance=expectedInstanceId==null?'':String(expectedInstanceId);
  let entry=container.items?.[index];
  // A loja pode estar aberta enquanto chega um snapshot autoritativo que
  // reorganiza stacks. Se o indice ficou antigo, recupere a entrada pelo
  // item esperado em vez de rejeitar uma acao legitima.
  if(expectedInstance && (!entry || String(entry.instanceId||'')!==expectedInstance)){
    index=(container.items||[]).findIndex(candidate=>String(candidate?.instanceId||'')===expectedInstance);
    entry=index>=0?container.items[index]:null;
  }else if(expected && (!entry || String(entry.itemId)!==expected)){
    index=(container.items||[]).findIndex(candidate=>String(candidate?.itemId||'')===expected);
    entry=index>=0?container.items[index]:null;
  }
  if(!entry)return {ok:false,message:'Item nao encontrado.'};
  entry.locked=!Boolean(entry.locked);
  return {ok:true,locked:entry.locked,itemId:String(entry.itemId),containerId:String(container.id),index};
}
