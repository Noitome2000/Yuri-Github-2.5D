// MKXP's sprite-effect wrapper also needs this varying for tone/color/opacity.
// Without it the engine falls back to the raw shader and loses those effects.
varying vec2 v_texCoord;
varying vec2 v_screenUV;

uniform sampler2D texture;
uniform sampler2D terrainData;
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
uniform float playerFootY;
uniform float tileSize;
uniform float maxTerrainHeight;
uniform vec4 terrainBounds;
uniform int renderMode;

bool atlasContains(vec2 world) {
    vec2 local = world - atlasOrigin;
    return local.x >= 0.0 && local.y >= 0.0 &&
           local.x < atlasSize.x && local.y < atlasSize.y;
}

vec2 atlasUV(vec2 world) {
    return (world - atlasOrigin) / atlasSize;
}

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
    float rayX = (screen.x - cameraCenter.x) / cameraFocal;
    float rayUp = -(screen.y - cameraCenter.y) / cameraFocal;
    float directionY = -cameraSinPitch * rayUp - cameraCosPitch;
    float directionZ = cameraCosPitch * rayUp - cameraSinPitch;
    if (directionZ >= -0.000001)
        discard;

    // Reject rays whose max-height-to-ground segment cannot enter any
    // authored cell. This keeps the wall fallback below cheap on sparse maps.
    float boundedHeight = clamp(maxTerrainHeight, 0.0, cameraHeight - 0.001);
    float boundTopDistance = (boundedHeight - cameraHeight) / directionZ;
    float boundGroundDistance = -cameraHeight / directionZ;
    boundGroundDistance = min(boundGroundDistance, farDistance / max(-directionY, 0.0001));
    float boundTopForward = boundTopDistance * directionY;
    float boundTopLateral = boundTopDistance * rayX;
    float boundGroundForward = boundGroundDistance * directionY;
    float boundGroundLateral = boundGroundDistance * rayX;
    vec2 boundTopWorld = vec2(
        displayPosition.x + cameraCenter.x +
        cameraSinYaw * boundTopForward + cameraCosYaw * boundTopLateral,
        displayPosition.y + cameraCenter.y + cameraBack +
        cameraCosYaw * boundTopForward - cameraSinYaw * boundTopLateral
    );
    vec2 boundGroundWorld = vec2(
        displayPosition.x + cameraCenter.x +
        cameraSinYaw * boundGroundForward + cameraCosYaw * boundGroundLateral,
        displayPosition.y + cameraCenter.y + cameraBack +
        cameraCosYaw * boundGroundForward - cameraSinYaw * boundGroundLateral
    );
    vec2 rayBoundsMin = min(boundTopWorld, boundGroundWorld);
    vec2 rayBoundsMax = max(boundTopWorld, boundGroundWorld);
    if (rayBoundsMax.x < terrainBounds.x || rayBoundsMin.x > terrainBounds.z ||
        rayBoundsMax.y < terrainBounds.y || rayBoundsMin.y > terrainBounds.w)
        discard;

    // This pass only draws authored elevated terrain. Starting at the ground
    // plane can sample a different cell from the projected top and converge to
    // zero height, making a platform flicker as the camera moves. Start at the
    // highest visible terrain plane and iterate down to the sampled surface.
    float seedHeight = clamp(maxTerrainHeight, 0.0, cameraHeight - 0.001);
    float rayDistance = (seedHeight - cameraHeight) / directionZ;
    vec2 world = vec2(0.0);
    vec4 terrain = vec4(0.0);
    bool converged = false;
    // Most pixels hit ordinary zero-height ground. Stop as soon as the
    // fixed-point ray is stable instead of paying five terrain texture reads
    // in every enabled full-screen layer. Complex slopes retain the same
    // four-step cap and one final sample as the previous implementation.
    for (int iteration = 0; iteration < 4; ++iteration) {
        float forward = rayDistance * directionY;
        float lateral = rayDistance * rayX;
        world.x = displayPosition.x + cameraCenter.x +
                  cameraSinYaw * forward + cameraCosYaw * lateral;
        world.y = displayPosition.y + cameraCenter.y + cameraBack +
                  cameraCosYaw * forward - cameraSinYaw * lateral;
        if (!atlasContains(world))
            break;
        terrain = texture2D(terrainData, atlasUV(world));
        float elevation = terrain.r * 255.0;
        float nextRayDistance = (elevation - cameraHeight) / directionZ;
        if (abs(nextRayDistance - rayDistance) < 0.01) {
            rayDistance = nextRayDistance;
            converged = true;
            break;
        }
        rayDistance = nextRayDistance;
    }

    float forward = rayDistance * directionY;
    float lateral = rayDistance * rayX;
    world.x = displayPosition.x + cameraCenter.x +
              cameraSinYaw * forward + cameraCosYaw * lateral;
    world.y = displayPosition.y + cameraCenter.y + cameraBack +
              cameraCosYaw * forward - cameraSinYaw * lateral;
    vec2 uv = atlasUV(world);
    if (!atlasContains(world)) {
        terrain = vec4(0.0);
        converged = false;
    } else if (!converged)
        terrain = texture2D(terrainData, uv);
    float elevation = terrain.r * 255.0;
    bool authored = terrain.b > 0.5;
    bool sideHit = false;

    // A stable fixed point can be a lower platform behind a nearer wall.
    // Only the highest plane is an unambiguous first hit. For other rays walk
    // the height texture's pixel cells in camera order, intersecting each solid
    // column analytically. Height slices can jump right across a narrow edge.
    if (!converged || !authored || elevation < boundedHeight - 0.25) {
        vec2 rayOrigin = displayPosition + cameraCenter + vec2(0.0, cameraBack);
        vec2 rayDirection = vec2(cameraSinYaw * directionY + cameraCosYaw * rayX,
                                 cameraCosYaw * directionY - cameraSinYaw * rayX);
        float entryDistance = boundTopDistance;
        float exitDistance = boundGroundDistance;
        if (converged && authored && elevation >= 0.25)
            exitDistance = min(exitDistance, rayDistance + 0.01);
        vec2 clipMin = max(atlasOrigin, terrainBounds.xy);
        vec2 clipMax = min(atlasOrigin + atlasSize, terrainBounds.zw);
        for (int axis = 0; axis < 2; ++axis) {
            if (abs(rayDirection[axis]) < 0.000001) {
                if (rayOrigin[axis] < clipMin[axis] || rayOrigin[axis] >= clipMax[axis])
                    discard;
            } else {
                float a = (clipMin[axis] - rayOrigin[axis]) / rayDirection[axis];
                float b = (clipMax[axis] - rayOrigin[axis]) / rayDirection[axis];
                entryDistance = max(entryDistance, min(a, b));
                exitDistance = min(exitDistance, max(a, b));
            }
        }
        if (entryDistance > exitDistance) discard;
        vec2 cell = floor(rayOrigin + rayDirection * (entryDistance + 0.0001) - atlasOrigin);
        vec2 stepCell = sign(rayDirection);
        vec2 deltaDistance = 1.0 / max(abs(rayDirection), vec2(0.000001));
        vec2 nextEdge = atlasOrigin + cell + max(stepCell, vec2(0.0));
        vec2 nextDistance = (nextEdge - rayOrigin) / vec2(
            abs(rayDirection.x) < 0.000001 ? 0.000001 : rayDirection.x,
            abs(rayDirection.y) < 0.000001 ? 0.000001 : rayDirection.y);
        if (abs(rayDirection.x) < 0.000001) nextDistance.x = 1.0e20;
        if (abs(rayDirection.y) < 0.000001) nextDistance.y = 1.0e20;
        bool found = false;
        // The visible ray is capped by the configured far plane; receiver queries
        // are capped by their object/beam depth. Stop as soon as a column hits.
        for (int column = 0; column < 4096; ++column) {
            if (entryDistance > exitDistance + 0.0001) break;
            vec2 cellUV = (cell + vec2(0.5)) / atlasSize;
            vec4 sampleTerrain = texture2D(terrainData, cellUV);
            float sampleElevation = sampleTerrain.r * 255.0;
            float segmentEnd = min(exitDistance, min(nextDistance.x, nextDistance.y));
            float topDistance = (sampleElevation - cameraHeight) / directionZ;
            float hitDistance = max(entryDistance, topDistance);
            if (sampleTerrain.b > 0.5 && sampleElevation >= 0.25 &&
                hitDistance <= segmentEnd + 0.0001) {
                rayDistance = hitDistance;
                // Keep the boundary's colour sample inside the hit texel.
                world = clamp(rayOrigin + rayDirection * rayDistance,
                              atlasOrigin + cell + vec2(0.001),
                              atlasOrigin + cell + vec2(0.999));
                terrain = sampleTerrain;
                elevation = sampleElevation;
                uv = atlasUV(world);
                // Slopes are stored as integer heights, so their one-pixel
                // quantisation steps are still top surface, not dark walls.
                sideHit = sampleElevation - (cameraHeight + hitDistance * directionZ) > 1.5;
                found = true;
                break;
            }
            if (segmentEnd >= exitDistance) break;
            bool crossX = nextDistance.x <= nextDistance.y;
            bool crossY = nextDistance.y <= nextDistance.x;
            entryDistance = segmentEnd;
            if (crossX) { cell.x += stepCell.x; nextDistance.x += deltaDistance.x; }
            if (crossY) { cell.y += stepCell.y; nextDistance.y += deltaDistance.y; }
        }
        if (!found) discard;
        authored = terrain.b > 0.5;
    }
    if (!authored || elevation < 0.25)
        discard;

    bool overpass = terrain.g > 0.5;

    // Keep the complete tile under the continuously moving foot point behind
    // the character. Classifying by the south edge made that tile foreground
    // between grid lines, so walking hid the character while stopping did not.
    float cellNorth = floor(world.y / tileSize) * tileSize;
    bool foreground = cellNorth >= playerFootY - 0.5;
    if (renderMode == 0 && (overpass || foreground))
        discard;
    if (renderMode == 1 && (overpass || !foreground))
        discard;
    if (renderMode == 2 && !overpass)
        discard;

    // The signed ray coordinate is the distance along the camera forward
    // axis.  Using world Y here breaks as soon as yaw is non-zero.
    float forwardDistance = -rayDistance * directionY;
    if (forwardDistance > farDistance)
        discard;
    vec4 pixel = texture2D(texture, uv);
    if (sideHit)
        pixel.rgb *= 0.72;
    if (forwardDistance > fadeStart)
        pixel.a *= clamp((farDistance - forwardDistance) /
                         max(farDistance - fadeStart, 0.0001), 0.0, 1.0);
    pixel.rgb = fxIlluminate(pixel.rgb, vec3(world, max(cameraHeight + rayDistance * directionZ, 0.0)));
    gl_FragColor = pixel;
}
