const foldState=new Map();
function fold(title,content,open=true){
  const details=document.createElement('details');details.className='ms-inspector-group';details.open=foldState.has(title)?foldState.get(title):open;
  const summary=document.createElement('summary');summary.textContent=title;details.append(summary,content);
  details.ontoggle=()=>foldState.set(title,details.open);return details;
}
function vectorRow(host,names,title,axes){
  const fields=names.map(name=>[...host.querySelectorAll('label.msp3d-field')].find(row=>row.querySelector('span')?.textContent===name));
  if(fields.some(row=>!row))return;
  const row=document.createElement('div');row.className='ms-vector-property';
  const label=document.createElement('span');label.className='ms-property-label';label.textContent=title;
  const values=document.createElement('div');values.className='ms-vector-values';fields[0].before(row);row.append(label,values);
  fields.forEach((field,index)=>{field.querySelector('input').setAttribute('aria-label',names[index]);field.querySelector('span').textContent=axes[index];field.classList.add('ms-axis-'+axes[index].toLowerCase());values.append(field);});
}
export function compactInspector(host){
  vectorRow(host,['占地宽','占地深'],'占地',['宽','深']);
  vectorRow(host,['偏移量 X','偏移量 Y','偏移量 Z'],'偏移量',['X','Y','Z']);
  vectorRow(host,['旋转 X','旋转 Y','旋转 Z'],'旋转',['X','Y','Z']);
  vectorRow(host,['地图 X','地图 Y'],'位置',['X','Z']);
  for(const section of [...host.querySelectorAll(':scope > .msp3d-section')]){
    const heading=section.querySelector(':scope > strong')||section.querySelector(':scope > .msp3d-section-heading strong');
    const preview=section.querySelector('.msp3d-object-preview');
    let title=heading?.textContent|| (preview?'预览':'属性');
    const header=heading?.closest('.msp3d-section-heading'),headerActions=header?[...header.querySelectorAll('button')]:[];
    if(title.startsWith('已选：'))title='变换';if(title==='资源属性')title='资源';
    if(heading)heading.remove();
    const checks=[...section.querySelectorAll(':scope > .msp3d-check')];
    if(checks.length>1){const line=document.createElement('div');line.className='ms-inspector-checks';checks[0].before(line);line.append(...checks);}
    for(const material of [...section.querySelectorAll(':scope > .ms-texture-row')]){
      const name=material.querySelector(':scope > strong');const slot=name?.textContent||'材质';name?.remove();
      const marker=document.createComment('material');material.before(marker);marker.replaceWith(fold(slot,material,slot==='材质 0'));
    }
    const marker=document.createComment('section');section.before(marker);const group=fold(title,section);marker.replaceWith(group);
    if(headerActions.length){const actions=document.createElement('span');actions.className='ms-inspector-header-actions';actions.append(...headerActions);group.querySelector('summary').append(actions);for(const b of headerActions)b.addEventListener('click',e=>e.stopPropagation());header.remove();}
  }
}

export const inspectorStyles=`
.ms-inspector .ms-vector-property{grid-template-columns:64px minmax(0,1fr)}
.ms-inspector .ms-vector-values .msp3d-field input{padding:2px!important}
.ms-vector-values input[type=number]{appearance:textfield}.ms-vector-values input[type=number]::-webkit-inner-spin-button,.ms-vector-values input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.ms-inspector .ms-dock-body{padding:6px}.ms-inspector-group{border:1px solid #202020;margin-bottom:5px;background:#303030}.ms-inspector-group>summary{height:25px;line-height:25px;cursor:pointer;padding:0 7px;background:#393939;font-size:12px;font-weight:500;user-select:none}.ms-inspector-group>.msp3d-section{border:0!important;margin:0!important;padding:6px!important;gap:5px!important}.ms-inspector-group .ms-inspector-group{margin:2px 0;border-color:#444}.ms-inspector-group .ms-inspector-group>summary{background:#333}
.ms-inspector .msp3d-field{display:grid!important;grid-template-columns:76px minmax(0,1fr);gap:5px!important;min-height:25px}.ms-inspector .msp3d-field input,.ms-inspector .msp3d-field select{width:100%!important;min-width:0!important;box-sizing:border-box;height:24px!important;padding:2px 5px!important;font-size:12px}.ms-inspector .msp3d-field>span{font-size:11px;color:#bbb}.ms-inspector .msp3d-fields{gap:4px!important}.ms-vector-property{display:grid;grid-template-columns:76px minmax(0,1fr);align-items:center;gap:5px;grid-column:1/-1}.ms-property-label{font-size:11px;color:#bbb}.ms-vector-values{display:flex;gap:4px;min-width:0}.ms-vector-values .msp3d-field{flex:1;min-width:0;grid-template-columns:auto minmax(0,1fr);gap:3px!important}.ms-vector-values .msp3d-field span{font-size:10px}.ms-vector-values .ms-axis-x>span{color:#ef8686}.ms-vector-values .ms-axis-y>span{color:#8dce8a}.ms-vector-values .ms-axis-z>span{color:#88b3ee}
.ms-inspector .msp3d-check{font-size:11px;min-height:24px;margin:0!important}.ms-inspector-checks{display:flex;flex-wrap:wrap;gap:6px}.ms-inspector .msp3d-turns{gap:4px!important;margin-top:3px!important}.ms-inspector .msp3d-turns button{padding:3px 6px!important}.ms-inspector .msp3d-object-preview{height:140px!important}.ms-inspector .ms-texture-row{padding:5px;border:0;gap:4px}.ms-inspector .ms-texture-row img{width:48px;height:48px;grid-row:1/3}.ms-inspector .ms-texture-row{grid-template-columns:48px minmax(0,1fr)}.ms-inspector .ms-texture-input{font-size:10px;grid-row:1}.ms-inspector .ms-texture-row>small{font-size:10px;grid-row:2}.ms-inspector .ms-texture-actions{grid-row:3}.ms-inspector .ms-texture-actions button{padding:3px 5px!important;font-size:11px}.ms-inspector .ms-texture-row select{font-size:11px;min-height:23px}.ms-hierarchy-tree-host{flex:1;min-height:0}.ms-inspector-header-actions{float:right}.ms-inspector-header-actions button{height:22px!important;padding:1px 5px!important;background:transparent!important;border:0!important;font-size:10px!important}
`;
