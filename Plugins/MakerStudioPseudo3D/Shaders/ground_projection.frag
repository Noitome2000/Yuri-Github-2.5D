varying vec2 v_texCoord;
varying vec2 v_screenUV;

uniform sampler2D texture;
uniform vec2 screenSize;
uniform vec2 atlasOrigin;
uniform vec2 atlasSize;
uniform vec2 displayPosition;
uniform vec2 cameraCenter;
uniform float cameraBack;
uniform float cameraHeight;
uniform float cameraSinPitch;
uniform float cameraCosPitch;
uniform float cameraFocal;
uniform float cameraSinYaw;
uniform float cameraCosYaw;
uniform float farDistance;
uniform float fadeStart;

// Shared bounded world-space lighting. Keep in sync across all three receivers.
uniform float fxLighting;
uniform float fxAmbient;
uniform int fxLightCount;
uniform vec4 fxLightPosition[8];
uniform vec4 fxLightColor[8];
uniform int fxConeCount;
uniform vec4 fxConePosition[8];
uniform vec4 fxConeColor[8];
uniform vec4 fxConeShape[8];
uniform vec3 fxConeDirection[8];
// Standard MKXP uniform: declaring it transfers tone ownership to this shader.
// The engine still applies opacity/color/bush effects, but does not tone twice.
uniform vec4 tone;
float fxToneRestore = 0.0;
vec3 fxApplyTone(vec3 rgb) {
    float gray = dot(rgb, vec3(0.299, 0.587, 0.114));
    return mix(rgb, vec3(gray), tone.w) + tone.rgb;
}
vec3 fxSurfaceColor(vec3 albedo, vec3 illumination) {
    vec3 lit = clamp(albedo * illumination, 0.0, 1.0);
    vec3 localLight = max(illumination - vec3(fxAmbient), vec3(0.0));
    // Match the existing radius/cone/intensity falloff, with no hard light edge.
    fxToneRestore = clamp(max(localLight.r, max(localLight.g, localLight.b)), 0.0, 1.0);
    vec3 ambient = clamp(albedo * fxAmbient, 0.0, 1.0);
    // Direct light keeps its original RGB energy. Strong light also restores
    // the neutral ambient base, reaching the original untinted lit pixel.
    vec3 tonedAmbient = clamp(fxApplyTone(ambient), 0.0, 1.0);
    return lit + (tonedAmbient - ambient) * (1.0 - fxToneRestore);
}
vec3 fxIlluminate(vec3 albedo, vec3 world) {
    fxToneRestore = 0.0;
    if (fxLighting < 0.5) return fxApplyTone(albedo);
    vec3 illumination = vec3(fxAmbient);
    for (int i = 0; i < 8; ++i) {
        if (i >= fxLightCount) break;
        vec3 delta = world - fxLightPosition[i].xyz;
        float distanceSquared = dot(delta, delta);
        float radiusSquared = fxLightPosition[i].w * fxLightPosition[i].w;
        float falloff = max(1.0 - distanceSquared / max(radiusSquared, 1.0), 0.0);
        illumination += fxLightColor[i].rgb * fxLightColor[i].a * falloff * falloff;
    }
    // Preserve the original point-light loop, including its operation order.
    // No per-light cone branch, square root or cone array read on this path.
    if (fxConeCount == 0) return fxSurfaceColor(albedo, illumination);
    for (int i = 0; i < 8; ++i) {
        if (i >= fxConeCount) break;
        vec3 delta = world - fxConePosition[i].xyz;
        float distanceSquared = dot(delta, delta);
        float radiusSquared = fxConePosition[i].w * fxConePosition[i].w;
        float falloff = max(1.0-distanceSquared/max(radiusSquared,1.0),0.0);
        vec3 axis = dot(fxConeDirection[i],fxConeDirection[i]) > 0.5 ? fxConeDirection[i] : vec3(0.0,0.0,-1.0);
        float cosine = dot(delta,axis)/max(sqrt(distanceSquared),0.0001);
        float angular = smoothstep(fxConeShape[i].x,fxConeShape[i].y,cosine);
        illumination += fxConeColor[i].rgb*fxConeColor[i].a*falloff*falloff*angular;
    }
    return fxSurfaceColor(albedo, illumination);
}

void main() {
    vec2 screen = v_screenUV * screenSize;
    float rayUp = -(screen.y - cameraCenter.y) / cameraFocal;
    float directionY = -cameraSinPitch * rayUp - cameraCosPitch;
    float directionZ = cameraCosPitch * rayUp - cameraSinPitch;
    if (directionZ >= -0.000001)
        discard;

    float rayDistance = -cameraHeight / directionZ;
    float forward = rayDistance * directionY;
    float lateral = rayDistance * ((screen.x - cameraCenter.x) / cameraFocal);
    float worldX = displayPosition.x + cameraCenter.x +
                   cameraSinYaw * forward + cameraCosYaw * lateral;
    float worldY = displayPosition.y + cameraCenter.y + cameraBack +
                   cameraCosYaw * forward - cameraSinYaw * lateral;
    float forwardDistance = -forward;
    if (forwardDistance > farDistance)
        discard;

    vec2 uv = (vec2(worldX, worldY) - atlasOrigin) / atlasSize;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0)
        discard;

    vec4 pixel = texture2D(texture, uv);
    if (forwardDistance > fadeStart)
        pixel.a *= clamp((farDistance - forwardDistance) /
                         max(farDistance - fadeStart, 0.0001), 0.0, 1.0);
    pixel.rgb = fxIlluminate(pixel.rgb, vec3(worldX, worldY, 0.0));
    gl_FragColor = pixel;
}
