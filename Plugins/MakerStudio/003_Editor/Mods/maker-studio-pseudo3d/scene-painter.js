// One persistent context per preview, bounded texture residency, and one draw
// call per consecutive material run/pass. Opaque texels write depth; preserve
// painter order only for translucent texels and placement ghosts.
function interpolatePoint(a,b,t) {
  const w=a[3]+(b[3]-a[3])*t;
  return [(a[0]*a[3]*(1-t)+b[0]*b[3]*t)/w,(a[1]*a[3]*(1-t)+b[1]*b[3]*t)/w,
    a[2]*(1-t)+b[2]*t,w,(a[4]*a[3]*(1-t)+b[4]*b[3]*t)/w];
}
export function clipNear(points,uv,near) {
  const result=[];
  for(let i=0;i<3;i++) {
    const a=points[i],b=points[(i+1)%3],u=uv?.[i]||[0,0],v=uv?.[(i+1)%3]||[0,0];
    if(a[3]>=near)result.push({p:a,uv:u});
    if((a[3]>=near)!==(b[3]>=near)) {
      const t=(near-a[3])/(b[3]-a[3]),p=interpolatePoint(a,b,t);p[3]=near;
      result.push({p,uv:u.map((n,j)=>n+(v[j]-n)*t)});
    }
  }
  return result;
}
function drawPerspectiveFallback(draw,ctx,image,points,uv,light,level=0) {
  const depths=points.map(p=>p[3]||1);
  if(level<5&&Math.max(...depths)/Math.min(...depths)>1.12) {
    const mid=points.map((p,i)=>interpolatePoint(p,points[(i+1)%3],.5));
    const tex=uv.map((p,i)=>p.map((n,j)=>(n+uv[(i+1)%3][j])/2));
    const all=[...points,...mid],coords=[...uv,...tex];
    for(const ids of [[0,3,5],[3,1,4],[5,4,2],[3,4,5]])drawPerspectiveFallback(draw,ctx,image,ids.map(i=>all[i]),ids.map(i=>coords[i]),light,level+1);
  } else draw(ctx,image,points,uv,light);
}
export class ScenePainter {
  constructor(drawTexturedTriangle) {
    this.drawTexturedTriangle = drawTexturedTriangle;
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
    this.textures = new Map(); this.colors = new Map(); this.frame = 0;
    this.data = new Float32Array(65536); this.used = 0;
    const gl = this.gl;
    if (!gl) return;
    try {
      const compile = (type, source) => {
        const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
        return shader;
      };
      const vs = compile(gl.VERTEX_SHADER, 'attribute vec4 p; attribute vec2 uv; attribute vec4 c; uniform vec2 size; varying vec2 v; varying vec4 color; void main(){gl_Position=vec4((p.x/size.x*2.0-1.0)*p.w,(1.0-p.y/size.y*2.0)*p.w,p.z*p.w,p.w);v=uv;color=c;}');
      const fs = compile(gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 v; varying vec4 color; uniform sampler2D tex; uniform bool opaquePass; void main(){vec4 t=texture2D(tex,fract(v));float a=t.a*color.a;if(a<=0.0||(opaquePass?a<1.0:a>=1.0))discard;gl_FragColor=vec4(t.rgb*color.rgb,a);}');
      this.program = gl.createProgram(); gl.attachShader(this.program, vs); gl.attachShader(this.program, fs); gl.linkProgram(this.program);
      gl.deleteShader(vs); gl.deleteShader(fs);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(this.program));
      gl.useProgram(this.program); this.size = gl.getUniformLocation(this.program, 'size');
      this.opaquePass = gl.getUniformLocation(this.program, 'opaquePass');
      this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      for (const [name, count, offset] of [['p',4,0],['uv',2,16],['c',4,24]]) {
        const location = gl.getAttribLocation(this.program, name);
        gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location,count,gl.FLOAT,false,40,offset);
      }
      gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);
      this.white = document.createElement('canvas'); this.white.width = this.white.height = 1;
      const ctx = this.white.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,1,1);
    } catch (error) { console.warn('3D preview GPU unavailable; using Canvas 2D', error); this.dispose(); }
  }
  begin(ctx) {
    this.ctx = ctx; this.frame++; this.used = 0; this.active = null;
    this.solids = []; this.runs = [];
    if (!this.gl || this.gl.isContextLost()) return false;
    const gl = this.gl;
    if (this.canvas.width !== ctx.canvas.width) this.canvas.width = ctx.canvas.width;
    if (this.canvas.height !== ctx.canvas.height) this.canvas.height = ctx.canvas.height;
    gl.viewport(0,0,this.canvas.width,this.canvas.height);
    gl.uniform2f(this.size,this.canvas.width,this.canvas.height);
    gl.depthMask(true);gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    return true;
  }
  texture(image) {
    const gl = this.gl;
    let entry = this.textures.get(image);
    if (!entry) {
      const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      const limit=gl.getParameter(gl.MAX_TEXTURE_SIZE);
      let upload=image;
      if(image.width>limit||image.height>limit) {
        upload=document.createElement('canvas');const factor=limit/Math.max(image.width,image.height);
        upload.width=Math.max(1,Math.floor(image.width*factor));upload.height=Math.max(1,Math.floor(image.height*factor));
        upload.getContext('2d').drawImage(image,0,0,upload.width,upload.height);
      }
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,upload);
      entry = { texture, frame: this.frame }; this.textures.set(image,entry);
    }
    entry.frame = this.frame; return entry.texture;
  }
  triangle(points, image = null, uv = null, color = '#ffffff', opacity = 1) {
    if(this.near>0&&points.some(p=>p[3]<this.near)) {
      const clipped=clipNear(points,uv,this.near);
      for(let i=1;i<clipped.length-1;i++) {
        const vertices=[clipped[0],clipped[i],clipped[i+1]];
        this.triangle(vertices.map(v=>v.p),image,vertices.map(v=>v.uv),color,opacity);
      }
      return;
    }
    const ctx = this.ctx;
    if (points.every(p => p[0] < 0) || points.every(p => p[1] < 0) ||
        points.every(p => p[0] > ctx.canvas.width) || points.every(p => p[1] > ctx.canvas.height)) return;
    if (!this.gpu) {
      ctx.save(); ctx.globalAlpha = opacity;
      if (image) drawPerspectiveFallback(this.drawTexturedTriangle,ctx,image,points,uv,color.startsWith('rgb') ? Number(color.match(/[\d.]+/)[0])/255 : 1);
      else { ctx.fillStyle=color; ctx.beginPath(); ctx.moveTo(...points[0].slice(0,2)); ctx.lineTo(...points[1].slice(0,2)); ctx.lineTo(...points[2].slice(0,2)); ctx.closePath(); ctx.fill(); }
      ctx.restore(); return;
    }
    const source = image || this.white;
    let batch;
    if (!image && opacity === 1) batch = this.solids;
    else {
      let run = this.runs[this.runs.length-1];
      if (!run || run.source !== source) {run={source,data:[]};this.runs.push(run);}
      batch = run.data;
    }
    let rgb = this.colors.get(color);
    if (!rgb) { const hex = color.replace('#',''); rgb = color.startsWith('rgb') ? color.match(/[\d.]+/g).slice(0,3).map(n=>Number(n)/255) : [0,2,4].map(i => parseInt(hex.slice(i,i+2),16)/255); this.colors.set(color,rgb); }
    for (let i=0;i<3;i++) {
      const p = points[i], t = uv?.[i] || [0,0];
      batch.push(p[0],p[1],p[4]??(-(p[2]||0)*(this.reverseDepth?-1:1)/100000),p[3]??1,t[0],1-t[1],rgb[0],rgb[1],rgb[2],opacity);
    }
  }
  quad(points, image, uv, opacity = 1) {
    for (const ids of [[0,1,2],[0,2,3]]) this.triangle(ids.map(i=>points[i]),image,ids.map(i=>uv[i]),'#ffffff',opacity);
  }
  flush(source, data) {
    if (!data.length) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D,this.texture(source));
    if (data.length > this.data.length) this.data = new Float32Array(data.length * 2);
    this.data.set(data);
    gl.bufferData(gl.ARRAY_BUFFER,this.data.subarray(0,data.length),gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES,0,data.length/10);
  }
  end() {
    if (!this.gpu) return;
    // A texture may contain solid wall/window pixels, holes and translucency.
    // Discard non-opaque texels in the depth-writing pass so overlapping model
    // faces occlude per pixel, without turning cutout holes into solid masks.
    this.gl.uniform1i(this.opaquePass,1);
    this.gl.depthMask(true);this.flush(this.white,this.solids);
    for(const run of this.runs)this.flush(run.source,run.data);
    // Blend only translucent texels against the completed opaque depth buffer.
    this.gl.uniform1i(this.opaquePass,0);
    this.gl.depthMask(false);for(const run of this.runs)this.flush(run.source,run.data);
    this.ctx.drawImage(this.canvas,0,0);
    for (const [image, entry] of this.textures) if (entry.frame < this.frame - 2 || (this.textures.size > 64 && entry.frame !== this.frame)) {
      this.gl.deleteTexture(entry.texture); this.textures.delete(image);
    }
  }
  dispose() {
    if (this.gl) {
      for (const entry of this.textures.values()) this.gl.deleteTexture(entry.texture);
      if (this.buffer) this.gl.deleteBuffer(this.buffer);
      if (this.program) this.gl.deleteProgram(this.program);
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null; this.textures.clear();
  }
}
