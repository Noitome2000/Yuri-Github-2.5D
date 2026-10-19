import {normalizeEffects} from './visual-effects.js';

export const PBS_PATH = 'PBS/map_3d.txt';
export const EFFECT_PROPERTIES = Object.freeze({preset:'EffectPreset',lighting:'PointLighting',
  ambient:'AmbientLight',strength:'EffectStrength',bloom:'Bloom',dof:'DepthOfField',maxLights:'MaxLights'});
// Keep validation aligned with MakerStudioPseudo3D::MapSettings::SCHEMA.
const schema = {
  Mode:['2D','2.5D','Inherit'], CameraPitch:[1,89], CameraTarget:[.05,.95],
  CameraFocalLength:[0,10], CameraHorizon:[0,.95], FarDistance:[8,128],
  ShowPanorama:'bool',DynamicShadows:'bool',Lighting:'bool',AmbientTone:[-255,255],
  ShadowAngle:[0,360],ShadowLength:[0,8],ShadowOpacity:[0,255,'int'],
  CloudHeightParallax:[0,8],SoftenCloudEdges:'bool',ModelGroundOffset:[-256,256],
  EffectPreset:['none','cartoon','hd2d'],PointLighting:'bool',AmbientLight:[.1,1.5],
  EffectStrength:[0,1],Bloom:[0,.5],DepthOfField:[0,1],MaxLights:[1,8,'int']
};
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);

export function parseMapSettings(text='') {
  const sections=new Map(), lines=String(text).match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean);
  let section=null;
  for(let i=0;i<lines.length;i++) {
    const line=lines[i].replace(/^\uFEFF/,'').replace(/[#;][^\r\n]*/,'').trim();
    if(!line)continue;
    const fail=message=>{throw Error(`${PBS_PATH}:${i+1}: ${message}`);};
    const heading=line.match(/^\[([^\]]+)\]$/);
    if(heading) {
      const label=heading[1].trim();
      const id=/^default$/i.test(label)?'default':/^\d+$/.test(label)&&Number(label)>0?Number(label):null;
      if(id===null)fail('节名必须为 [Default] 或正整数地图编号');
      if(sections.has(id))fail(`重复的地图节 [${label}]`);
      section={id,start:i,values:{},positions:{}};sections.set(id,section);continue;
    }
    if(!section)fail('参数必须放在地图节内');
    const property=line.match(/^(\w+)\s*=\s*(.*?)\s*$/);
    if(!property)fail('参数格式应为 Property = Value');
    const [,name,raw]=property,spec=schema[name];
    if(!spec)fail(`未知参数 ${name}`);
    if(own(section.values,name))fail(`重复参数 ${name}`);
    let value;
    if(spec==='bool')value=/^(true|false)$/i.test(raw)?raw.toLowerCase()==='true':undefined;
    else if(typeof spec[0]==='string')value=spec.find(v=>v.toLowerCase()===raw.toLowerCase());
    else {
      const valid=spec[2]==='int'?/^[+-]?\d+$/.test(raw):/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw);
      const number=Number(raw);
      if(valid&&Number.isFinite(number)&&number>=spec[0]&&number<=spec[1])value=number;
    }
    if(value===undefined)fail(`无效的 ${name}=${raw}`);
    section.values[name]=value;section.positions[name]=i;
  }
  return {text:String(text),lines,sections};
}

function mapOverride(doc,mapId,key) {return doc.sections.get(mapId)?.values[EFFECT_PROPERTIES[key]];}
function sourceToken(doc,mapId,key) {
  const value=mapOverride(doc,mapId,key);
  return JSON.stringify(value===undefined?['inherited',doc.sections.get('default')?.values[EFFECT_PROPERTIES[key]]]:['map',value]);
}

export function patchMapEffects(text,mapId,changes) {
  if(!Number.isSafeInteger(mapId)||mapId<1)throw Error('无效的地图编号');
  let result=text;
  for(const [key,value] of Object.entries(changes)) {
    const name=EFFECT_PROPERTIES[key];if(!name)throw Error(`未知特效 ${key}`);
    const doc=parseMapSettings(result),section=doc.sections.get(mapId),index=section?.positions[name];
    if(value===mapOverride(doc,mapId,key))continue;
    const lines=doc.lines.slice(),newline=result.match(/\r\n|\n|\r/)?.[0]||'\n';
    if(index!==undefined) {
      const raw=lines[index],ending=raw.match(/(?:\r\n|\n|\r)$/)?.[0]||'';
      const parts=raw.slice(0,raw.length-ending.length).match(/^(\s*\w+\s*=\s*)(.*?)([ \t]*(?:[#;].*)?)$/);
      if(value===undefined) {
        const comment=parts[3].trimStart();
        lines.splice(index,1,...(comment?[`${raw.match(/^[ \t]*/)[0]}${comment}${ending}`]:[]));
      } else lines[index]=`${parts[1]}${String(value)}${parts[3]}${ending}`;
    } else if(value!==undefined) {
      if(section) {
        const at=Math.max(section.start,...Object.values(section.positions))+1;
        if(at>0&&!/[\r\n]$/.test(lines[at-1]))lines[at-1]+=newline;
        lines.splice(at,0,`${name} = ${String(value)}${newline}`);
      } else {
        if(lines.length&&!/[\r\n]$/.test(lines.at(-1)))lines[lines.length-1]+=newline;
        lines.push(`${lines.length?newline:''}[${String(mapId).padStart(3,'0')}]${newline}${name} = ${String(value)}${newline}`);
      }
    }
    result=lines.join('');
    parseMapSettings(result);
  }
  return result;
}

// Authored scene settings stay separate from PBS overrides, so viewing/saving
// unrelated objects never freezes inherited defaults into a map section.
export class PBSEffectsSync {
  constructor(mapId,text='') {this.mapId=mapId;this.document=parseMapSettings(text);this.pending=new Map();}
  refresh(text) {this.document=parseMapSettings(text);}
  override(key) {return this.pending.has(key)?this.pending.get(key).value:mapOverride(this.document,this.mapId,key);}
  effective(authored) {
    const values={...normalizeEffects(authored)},defaults=this.document.sections.get('default')?.values||{};
    for(const [key,name] of Object.entries(EFFECT_PROPERTIES)) {
      const value=this.override(key)??defaults[name];
      if(value!==undefined)values[key]=value;
    }
    return normalizeEffects(values);
  }
  set(key,value,authored) {
    if(!own(EFFECT_PROPERTIES,key))throw Error(`未知特效 ${key}`);
    const basis=this.pending.get(key)?.basis??sourceToken(this.document,this.mapId,key);
    // Keep even a return to the current disk value: an in-flight save may be
    // about to replace it. The patcher omits unchanged values on normal saves.
    this.pending.set(key,{value,basis,authored:this.pending.has(key)?this.pending.get(key).authored:authored});
  }
  conflicts(edits=this.pending) {
    return [...edits].filter(([key,edit])=>edit.basis!==sourceToken(this.document,this.mapId,key)&&
      edit.value!==mapOverride(this.document,this.mapId,key)).map(([key])=>key);
  }
  resolve(key,keepEditor) {
    if(keepEditor) {const edit=this.pending.get(key);if(edit)this.pending.set(key,{...edit,basis:sourceToken(this.document,this.mapId,key)});}
    else this.pending.delete(key);
  }
  prepare(text,edits=new Map(this.pending)) {
    this.refresh(text);
    const conflicts=this.conflicts(edits);
    if(conflicts.length)throw Error(`PBS 与编辑器同时修改了 ${conflicts.map(k=>EFFECT_PROPERTIES[k]).join('、')}，请在场景渲染中选择保留哪一边`);
    return {before:text,text:patchMapEffects(text,this.mapId,Object.fromEntries([...edits].map(([k,e])=>[k,e.value]))),edits};
  }
  accept(plan,authored) {
    this.refresh(plan.text);
    for(const [key,edit] of plan.edits) {
      if(this.pending.get(key)===edit)this.pending.delete(key);
      else if(this.pending.has(key))this.pending.set(key,{...this.pending.get(key),
        authored:authored?.[key]??this.pending.get(key).authored,basis:sourceToken(this.document,this.mapId,key)});
    }
  }
}

export async function readPBS(fs) {
  try {return await fs.readProjectFile(PBS_PATH);}
  catch(error) {
    // Never treat a permissions/IO error as an empty file and overwrite it.
    if(error?.code==='ENOENT'||/ENOENT|not found|does not exist|cannot find|找不到|不存在|os error [23]\b/i.test(String(error?.message||error)))return '';
    throw error;
  }
}
