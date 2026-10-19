varying vec2 v_texCoord;
varying vec2 v_pixelCoord;
varying vec2 v_screenCoord;

uniform sampler2D texture;
uniform sampler2D fogTexture;
uniform sampler2D modelPositionTexture;
uniform vec2 fogUVCenter;
uniform vec2 objectPixelAnchor;
uniform vec2 fogUVPerPixelX;
uniform vec2 fogUVPerPixelY;
uniform vec2 fogWorldOffset;
uniform vec2 fogWorldOrigin;
uniform vec2 fogTextureWorldSize;
uniform vec2 modelPositionSize;
uniform vec2 displayPosition;
uniform vec2 cameraCenter;
uniform float cameraBack;
uniform float cameraHeight;
uniform float cameraSinPitch;
uniform float cameraCosPitch;
uniform float cameraFocal;
uniform float cameraSinYaw;
uniform float cameraCosYaw;
uniform vec2 cloudHeightDirection;
uniform float modelHeightMin;
uniform float modelHeightSpan;
uniform float useModelPosition;
uniform float useStandingPlane;
uniform float standingWorldY;
uniform float fogOpacity;
uniform float softenEdges;

float decodeHeight(vec4 surface) {
    return dot(surface.rg, vec2(65280.0, 255.0)) / 65535.0;
}

// Decode before interpolating: filtering the packed bytes across a carry
// corrupts height. Ignore empty texels and unrelated surfaces at silhouettes.
float surfaceHeight(vec2 uv, vec4 nearestSurface) {
    vec2 p = uv * modelPositionSize - 0.5;
    vec2 base = floor(p);
    vec2 f = fract(p);
    float nearestHeight = decodeHeight(nearestSurface);
    float total = 0.0;
    float weightSum = 0.0;
    float limit = max(2.0, modelHeightSpan * 4.0 / modelPositionSize.y);
    for (int y = 0; y < 2; ++y) {
        for (int x = 0; x < 2; ++x) {
            vec2 offset = vec2(float(x), float(y));
            vec4 sampleSurface = texture2D(modelPositionTexture,
                (base + offset + 0.5) / modelPositionSize);
            float h = decodeHeight(sampleSurface);
            vec2 w = mix(1.0 - f, f, offset);
            float weight = w.x * w.y * step(0.5, sampleSurface.a) *
                step(abs(h - nearestHeight) * modelHeightSpan, limit);
            total += h * weight;
            weightSum += weight;
        }
    }
    return modelHeightMin + modelHeightSpan *
        (weightSum > 0.0001 ? total / weightSum : nearestHeight);
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
uniform float fxConeBillboard[8];
uniform vec3 fxConeObjectOffset;
uniform float fxBillboardLighting;
uniform float occlusionObjectDepth;
uniform vec3 fxObjectAnchor;
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
        vec3 delta = world + fxConeObjectOffset - fxConePosition[i].xyz;
        float distanceSquared = dot(delta, delta);
        float radiusSquared = fxConePosition[i].w * fxConePosition[i].w;
        float falloff = max(1.0-distanceSquared/max(radiusSquared,1.0),0.0);
        // A sprite represents a body volume, not a wafer-thin vertical wall.
        // Use its lower body for cone coverage, retaining per-pixel distance
        // and colour. This avoids a dark head / bright feet cut across a face.
        vec3 angularDelta = delta;
        if (fxBillboardLighting > 0.5)
            angularDelta.z = fxObjectAnchor.z + min(world.z-fxObjectAnchor.z,16.0) - fxConePosition[i].z;
        vec3 axis = dot(fxConeDirection[i],fxConeDirection[i]) > 0.5 ? fxConeDirection[i] : vec3(0.0,0.0,-1.0);
        float cosine = dot(angularDelta,axis)/max(length(angularDelta),0.0001);
        float angular = smoothstep(fxConeShape[i].x,fxConeShape[i].y,cosine);
        illumination += fxConeColor[i].rgb*fxConeColor[i].a*falloff*falloff*angular;
    }
    return fxSurfaceColor(albedo, illumination);
}

uniform vec4 fxFrame;
uniform vec2 fxTextureSize;
uniform float fxWind;
uniform vec2 fxWindBounds;
uniform float fxTime;
uniform float fxPhase;
uniform float fxObjectScale;

// Native/extended standing tiles are quads in a constant world-Y plane,
// including in-plane rotations and flips. Screen-ray intersection avoids
// affine UV seams between tiles at different perspective depths/heights.
float standingPlaneDepth() {
    float rayX = (v_screenCoord.x-cameraCenter.x)/cameraFocal;
    float rayUp = (cameraCenter.y-v_screenCoord.y)/cameraFocal;
    float dirY = cameraCosYaw*(-cameraSinPitch*rayUp-cameraCosPitch)-cameraSinYaw*rayX;
    float safeY = dirY < 0.0 ? min(dirY,-0.000001) : max(dirY,0.000001);
    return (standingWorldY-displayPosition.y-cameraCenter.y-cameraBack)/safeY;
}

vec3 standingPlaneWorld() {
    float rayX = (v_screenCoord.x-cameraCenter.x)/cameraFocal;
    float rayUp = (cameraCenter.y-v_screenCoord.y)/cameraFocal;
    float distance = standingPlaneDepth();
    float forward = distance*(-cameraSinPitch*rayUp-cameraCosPitch);
    float lateral = distance*rayX;
    return vec3(displayPosition.x+cameraCenter.x+cameraSinYaw*forward+cameraCosYaw*lateral,
                standingWorldY, cameraHeight+distance*(cameraCosPitch*rayUp-cameraSinPitch));
}

vec3 fxObjectWorld(vec2 uv) {
    if (useStandingPlane > 0.5) return standingPlaneWorld();
    if (useModelPosition > 0.5) {
        vec4 surface = texture2D(modelPositionTexture,
            (floor(uv * modelPositionSize) + 0.5) / modelPositionSize);
        float height = surfaceHeight(uv, surface);
        float rayX = (v_screenCoord.x - cameraCenter.x) / cameraFocal;
        float rayUp = -(v_screenCoord.y - cameraCenter.y) / cameraFocal;
        float dirY = -cameraSinPitch * rayUp - cameraCosPitch;
        float dirZ = cameraCosPitch * rayUp - cameraSinPitch;
        float safeZ = dirZ < 0.0 ? min(dirZ, -0.000001) : max(dirZ, 0.000001);
        float distance = (height - cameraHeight) / safeZ;
        float forward = distance * dirY;
        float lateral = distance * rayX;
        return vec3(displayPosition.x + cameraCenter.x + cameraSinYaw * forward + cameraCosYaw * lateral,
                    displayPosition.y + cameraCenter.y + cameraBack + cameraCosYaw * forward - cameraSinYaw * lateral, height);
    }
    vec2 local = uv * fxTextureSize - fxFrame.xy;
    float horizontal = (local.x - fxFrame.z * 0.5) * fxObjectScale;
    float height = (fxFrame.w - local.y) * fxObjectScale;
    return fxObjectAnchor + vec3(cameraCosYaw * horizontal, -cameraSinYaw * horizontal, height);
}

float fxHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float fxNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    return mix(mix(fxHash(i), fxHash(i+vec2(1.0,0.0)), f.x),
               mix(fxHash(i+vec2(0.0,1.0)), fxHash(i+vec2(1.0,1.0)), f.x), f.y);
}
// Analytic noise gradient: rotating it produces local currents with different
// directions, without four extra finite-difference noise evaluations per pixel.
vec2 fxCurl(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.0-2.0*f), du = 6.0*f*(1.0-f);
    float a=fxHash(i), b=fxHash(i+vec2(1.0,0.0));
    float c=fxHash(i+vec2(0.0,1.0)), d=fxHash(i+vec2(1.0,1.0));
    vec2 gradient = vec2(mix(b-a,d-c,u.y)*du.x,
                         mix(c-a,d-b,u.x)*du.y);
    return vec2(gradient.y,-gradient.x);
}

// BEGIN GENERATED TERRAIN QUERY (Tools/sync_terrain_occlusion.py)
uniform sampler2D occlusionData;
uniform vec2 occlusionOrigin;
uniform vec2 occlusionSize;
uniform vec4 occlusionBounds;
uniform float occlusionHeight;
uniform float occlusionEnabled;
bool occlusionContains(vec2 world) {
    vec2 local = world - occlusionOrigin;
    return local.x >= 0.0 && local.y >= 0.0 &&
           local.x < occlusionSize.x && local.y < occlusionSize.y;
}

vec2 occlusionUV(vec2 world) {
    return (world - occlusionOrigin) / occlusionSize;
}


float terrainRayDistance(vec2 screen, float limit) {


    float rayX = (screen.x - cameraCenter.x) / cameraFocal;
    float rayUp = -(screen.y - cameraCenter.y) / cameraFocal;
    float directionY = -cameraSinPitch * rayUp - cameraCosPitch;
    float directionZ = cameraCosPitch * rayUp - cameraSinPitch;
    if (directionZ >= -0.000001)
        return limit;

    // Reject rays whose max-height-to-ground segment cannot enter any
    // authored cell. This keeps the wall fallback below cheap on sparse maps.
    float boundedHeight = clamp(occlusionHeight, 0.0, cameraHeight - 0.001);
    float boundTopDistance = (boundedHeight - cameraHeight) / directionZ;
    if (boundTopDistance >= limit) return limit;
    float boundGroundDistance = min(-cameraHeight / directionZ, limit);
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
    if (rayBoundsMax.x < occlusionBounds.x || rayBoundsMin.x > occlusionBounds.z ||
        rayBoundsMax.y < occlusionBounds.y || rayBoundsMin.y > occlusionBounds.w)
        return limit;

    // This pass only draws authored elevated terrain. Starting at the ground
    // plane can sample a different cell from the projected top and converge to
    // zero height, making a platform flicker as the camera moves. Start at the
    // highest visible terrain plane and iterate down to the sampled surface.
    float seedHeight = clamp(occlusionHeight, 0.0, cameraHeight - 0.001);
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
        if (!occlusionContains(world))
            break;
        terrain = texture2D(occlusionData, occlusionUV(world));
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
    vec2 uv = occlusionUV(world);
    if (!occlusionContains(world)) {
        terrain = vec4(0.0);
        converged = false;
    } else if (!converged)
        terrain = texture2D(occlusionData, uv);
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
        vec2 clipMin = max(occlusionOrigin, occlusionBounds.xy);
        vec2 clipMax = min(occlusionOrigin + occlusionSize, occlusionBounds.zw);
        for (int axis = 0; axis < 2; ++axis) {
            if (abs(rayDirection[axis]) < 0.000001) {
                if (rayOrigin[axis] < clipMin[axis] || rayOrigin[axis] >= clipMax[axis])
                    return limit;
            } else {
                float a = (clipMin[axis] - rayOrigin[axis]) / rayDirection[axis];
                float b = (clipMax[axis] - rayOrigin[axis]) / rayDirection[axis];
                entryDistance = max(entryDistance, min(a, b));
                exitDistance = min(exitDistance, max(a, b));
            }
        }
        if (entryDistance > exitDistance) return limit;
        vec2 cell = floor(rayOrigin + rayDirection * (entryDistance + 0.0001) - occlusionOrigin);
        vec2 stepCell = sign(rayDirection);
        vec2 deltaDistance = 1.0 / max(abs(rayDirection), vec2(0.000001));
        vec2 nextEdge = occlusionOrigin + cell + max(stepCell, vec2(0.0));
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
            vec2 cellUV = (cell + vec2(0.5)) / occlusionSize;
            vec4 sampleTerrain = texture2D(occlusionData, cellUV);
            float sampleElevation = sampleTerrain.r * 255.0;
            float segmentEnd = min(exitDistance, min(nextDistance.x, nextDistance.y));
            float topDistance = (sampleElevation - cameraHeight) / directionZ;
            float hitDistance = max(entryDistance, topDistance);
            if (sampleTerrain.b > 0.5 && sampleElevation >= 0.25 &&
                hitDistance <= segmentEnd + 0.0001) {
                rayDistance = hitDistance;
                // Keep the boundary's colour sample inside the hit texel.
                world = clamp(rayOrigin + rayDirection * rayDistance,
                              occlusionOrigin + cell + vec2(0.001),
                              occlusionOrigin + cell + vec2(0.999));
                terrain = sampleTerrain;
                elevation = sampleElevation;
                uv = occlusionUV(world);
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
        if (!found) return limit;
        authored = terrain.b > 0.5;
    }
    if (!authored || elevation < 0.25)
        return limit;


    return min(rayDistance, limit);
}
// END GENERATED TERRAIN QUERY

// BEGIN SHARED STREET VOLUME
// Integrate only the camera-to-surface part of a street light volume.
float streetVolume(vec3 direction, float surfaceLimit, vec4 beamPosition,
                   vec4 beamColor, vec4 beamShape, float beamBillboard,
                   vec3 beamDirection) {
    vec3 origin = vec3(displayPosition+cameraCenter+vec2(0.0,cameraBack),cameraHeight);
    if (beamBillboard > 0.5) {
        // Inverse of project_beam_point. Height has the sprite's camera-up
        // direction, with no perspective lean; the base plane is unchanged.
        float cp = max(cameraCosPitch,0.0001);
        float height = (origin.z-beamShape.z)/cp;
        vec2 forwardAxis = vec2(cameraSinYaw,cameraCosYaw)*cameraSinPitch;
        origin.xy += forwardAxis*height;
        origin.z = beamShape.z+height;
        direction.xy += forwardAxis*(direction.z/cp);
        direction.z /= cp;
        // Keep the original ray parameter: terrain clipping uses this t.
    }
    vec3 q = origin-beamPosition.xyz;
    float range = beamPosition.w;
    // Start with the light sphere and the source's ground/apex planes.
    float rayLength = length(direction);
    float aa = dot(direction,direction);
    float b = dot(q,direction), disc = b*b-aa*(dot(q,q)-range*range);
    if (disc <= 0.0) return 0.0;
    float lo = max(0.0,(-b-sqrt(disc))/aa), hi = min(surfaceLimit,(-b+sqrt(disc))/aa);
    vec3 axis = dot(beamDirection,beamDirection)>0.5 ? beamDirection : vec3(0.0,0.0,-1.0);
    float qAxis = dot(q,axis), dAxis = dot(direction,axis);
    // The forward cone half-space replaces the old horizontal apex plane.
    if (abs(dAxis)<0.000001) { if (qAxis<0.0) return 0.0; }
    else if (dAxis>0.0) lo=max(lo,-qAxis/dAxis);
    else hi=min(hi,-qAxis/dAxis);
    // The physical ground/terrain ray supplies the end, including lower ground
    // beside an elevated light. There is no hard source-base height cutoff.
    float cosine2=beamShape.x*beamShape.x;
    float qa=cosine2*aa-dAxis*dAxis;
    float qb=cosine2*dot(q,direction)-qAxis*dAxis;
    float qc=cosine2*dot(q,q)-qAxis*qAxis;
    float d=qb*qb-qa*qc;
    if (abs(qa)<0.000001) {
        if (abs(qb)<0.000001) { if (qc>0.0) return 0.0; }
        else if (qb>0.0) hi=min(hi,-qc/(2.0*qb));
        else lo=max(lo,-qc/(2.0*qb));
    } else if (d<0.0) {
        if (qa>0.0) return 0.0;
    } else {
        float r0=(-qb-sqrt(d))/qa, r1=(-qb+sqrt(d))/qa;
        float enter=min(r0,r1), leave=max(r0,r1);
        if (qa>0.0) { lo=max(lo,enter); hi=min(hi,leave); }
        else if (lo<enter) hi=min(hi,enter);
        else lo=max(lo,leave);
    }
    if (hi<=lo) return 0.0;
    float density=0.0;
    for (int i=0;i<12;++i) {
        vec3 delta=q+direction*mix(lo,hi,(float(i)+0.5)/12.0);
        float dist2=dot(delta,delta);
        float angular=smoothstep(beamShape.x,beamShape.y,dot(delta,axis)/max(sqrt(dist2),0.0001));
        float attenuation=max(1.0-dist2/(range*range),0.0);
        density+=angular*attenuation*attenuation;
    }
    density*= (hi-lo)*rayLength/(12.0*max(beamPosition.z-beamShape.z,32.0));
    float alpha=1.0-exp(-density*beamShape.w*beamColor.a*3.0);
    return clamp(alpha,0.0,0.85);
}
// END SHARED STREET VOLUME

vec3 modelFrontVolume() {
    if (useModelPosition < 0.5 || fxLighting < 0.5 || fxConeCount == 0)
        return vec3(0.0);
    vec4 surface = texture2D(modelPositionTexture,
        (floor(v_texCoord * modelPositionSize) + 0.5) / modelPositionSize);
    if (surface.a < 0.5) return vec3(0.0);
    float height = surfaceHeight(v_texCoord, surface);
    float up = (cameraCenter.y - v_screenCoord.y) / cameraFocal;
    float lateral = (v_screenCoord.x - cameraCenter.x) / cameraFocal;
    float forward = -cameraSinPitch * up - cameraCosPitch;
    vec3 direction = vec3(cameraSinYaw * forward + cameraCosYaw * lateral,
        cameraCosYaw * forward - cameraSinYaw * lateral,
        cameraCosPitch * up - cameraSinPitch);
    if (abs(direction.z) < 0.000001) return vec3(0.0);
    float distance = (height - cameraHeight) / direction.z;
    if (distance <= 0.0) return vec3(0.0);
    vec3 light = vec3(0.0);
    for (int i = 0; i < 8; ++i) {
        if (i >= fxConeCount) break;
        if (fxConeShape[i].w <= 0.0 || fxConeColor[i].a <= 0.0) continue;
        light += fxConeColor[i].rgb * streetVolume(direction, distance,
            fxConePosition[i], fxConeColor[i], fxConeShape[i],
            fxConeBillboard[i], fxConeDirection[i]);
    }
    return light;
}

// Independent model occlusion. The immutable texture stores model AABBs and
// triangles in world space (24-bit coordinates); ray/AABB rejection avoids
// testing distant meshes. This has no fixed model/triangle uniform-array cap.
uniform sampler2D walkGeometry;
uniform vec2 walkTextureSize;
uniform vec3 walkOrigin;
uniform vec3 walkSpan;
uniform int walkModelCount;
// Zero for characters; model receivers skip their own mesh (one-based index).
uniform int walkSelfModel;
uniform int walkStandingReceiver;
uniform float walkCharacterDepth;
float walkNumber(float index) {
    vec2 uv = (vec2(mod(index,walkTextureSize.x),floor(index/walkTextureSize.x))+0.5)/walkTextureSize;
    return dot(floor(texture2D(walkGeometry,uv).rgb*255.0+0.5),vec3(65536.0,256.0,1.0));
}
vec3 walkVertex(float index) {
    return walkOrigin+walkSpan*vec3(walkNumber(index),walkNumber(index+1.0),walkNumber(index+2.0))/16777215.0;
}
float walkTriangleDistance(vec3 eye, vec3 ray, float at) {
    vec3 a=walkVertex(at),e1=walkVertex(at+3.0)-a,e2=walkVertex(at+6.0)-a;
    vec3 p=cross(ray,e2);
    float det=dot(e1,p);
    if(abs(det)<0.000001)return -1.0;
    vec3 t=eye-a;
    float u=dot(t,p)/det;
    if(u<0.0||u>1.0)return -1.0;
    vec3 q=cross(t,e1);
    float v=dot(ray,q)/det;
    if(v<0.0||u+v>1.0)return -1.0;
    return dot(e2,q)/det;
}
bool walkHidden(vec2 screen, float receiverDepth) {
    float up = (cameraCenter.y-screen.y)/cameraFocal;
    float lateral = (screen.x-cameraCenter.x)/cameraFocal;
    float forward = -cameraSinPitch*up-cameraCosPitch;
    vec3 ray = vec3(cameraSinYaw*forward+cameraCosYaw*lateral,
        cameraCosYaw*forward-cameraSinYaw*lateral,cameraCosPitch*up-cameraSinPitch);
    vec3 eye = vec3(displayPosition+cameraCenter+vec2(0.0,cameraBack),cameraHeight);
    if (walkSelfModel>0) {
        // The packed height bake can interpolate across a thin riser. Refine
        // against the receiver's own mesh, in the same space as its occluders.
        // Keep baked depth only for silhouette pixels outside the exact mesh.
        float header=float(walkSelfModel-1)*8.0;
        float start=walkNumber(header+6.0),nearest=1.0e20;
        int count=int(walkNumber(header+7.0));
        for(int i=0;i<count;++i) {
            float d=walkTriangleDistance(eye,ray,start+float(i)*9.0);
            if(d>0.0)nearest=min(nearest,d);
        }
        if(nearest<1.0e19)receiverDepth=nearest;
    }
    vec3 safeRay = vec3(abs(ray.x)<0.000001?0.000001:ray.x,
        abs(ray.y)<0.000001?0.000001:ray.y,abs(ray.z)<0.000001?0.000001:ray.z);
    for (int m=0;m<walkModelCount;++m) {
        if (m+1 == walkSelfModel) continue;
        float header = float(m)*8.0;
        vec3 lo=(walkVertex(header)-eye)/safeRay, hi=(walkVertex(header+3.0)-eye)/safeRay;
        vec3 nearT=min(lo,hi),farT=max(lo,hi);
        float enter=max(max(nearT.x,nearT.y),max(nearT.z,0.0));
        float limit=receiverDepth+(walkSelfModel>0 ? 0.35 : -0.35);
        float leave=min(min(farT.x,farT.y),min(farT.z,limit));
        if(leave<enter)continue;
        float start=walkNumber(header+6.0);
        int count=int(walkNumber(header+7.0));
        for(int i=0;i<count;++i) {
            float at=start+float(i)*9.0;
            float distance=walkTriangleDistance(eye,ray,at);
            // Adjacent stair modules may duplicate a landing at exactly the
            // same height. Give coincident faces one stable owner so changing
            // Sprite order cannot swap their materials or cause flicker.
            bool coincident=walkSelfModel>0 && m+1>walkSelfModel &&
                abs(distance-receiverDepth)<=0.35;
            if(distance>0.0&&(distance<receiverDepth-0.35||coincident))return true;
        }
    }
    return false;
}

void main() {
    vec2 sampleUV = v_texCoord;
    vec4 original = texture2D(texture, v_texCoord);
    if (original.a <= 0.001) discard;
    if (walkModelCount > 0) {
        float depth = walkStandingReceiver > 0 ? standingPlaneDepth() : walkCharacterDepth;
        if (walkSelfModel > 0 && useModelPosition > 0.5) {
            vec4 surface = texture2D(modelPositionTexture,
                (floor(v_texCoord*modelPositionSize)+0.5)/modelPositionSize);
            float height = surfaceHeight(v_texCoord,surface);
            float rayUp = (cameraCenter.y-v_screenCoord.y)/cameraFocal;
            float dirZ = cameraCosPitch*rayUp-cameraSinPitch;
            if (abs(dirZ)>0.000001) depth=(height-cameraHeight)/dirZ;
        }
        if (depth>0.0 && walkHidden(v_screenCoord,depth)) discard;
    }
    if (occlusionEnabled > 0.5) {
        float depth = useStandingPlane > 0.5 ? standingPlaneDepth() : occlusionObjectDepth;
        if (useModelPosition > 0.5) {
            vec4 surface = texture2D(modelPositionTexture,
                (floor(v_texCoord*modelPositionSize)+0.5)/modelPositionSize);
            float height = surfaceHeight(v_texCoord,surface);
            float rayUp = (cameraCenter.y-v_screenCoord.y)/cameraFocal;
            float dirZ = cameraCosPitch*rayUp-cameraSinPitch;
            if (dirZ < -0.000001) depth = (height-cameraHeight)/dirZ;
        }
        // One world-pixel contact tolerance protects roots on the same surface.
        if (terrainRayDistance(v_screenCoord,depth) < depth-1.0) discard;
    }
    if (fxWind > 0.0) {
        vec2 local = v_texCoord * fxTextureSize - fxFrame.xy;
        // Advected 2D patches disturb the foliage texture, not horizontal rows
        // or the whole crown. Keep the silhouette and root anchor stationary.
        float bottom = fxWindBounds.y > fxWindBounds.x ? fxWindBounds.y : fxFrame.w;
        float top = fxWindBounds.y > fxWindBounds.x ? fxWindBounds.x : 0.0;
        float crown = smoothstep(0.18, 0.65, (bottom-local.y) / max(bottom-top, 1.0));
        float height = max(bottom-top, 1.0);
        float amplitude = min(clamp(height * 0.009, 0.6, 1.3) * fxWind, 3.0);
        // Small leaf-sized currents overlap while travelling in different
        // directions. A slower curved gust envelope reveals passing trails.
        vec2 q = vec2(local.x, local.y-top) / clamp(height*0.04, 3.0, 7.0);
        q += vec2(fxPhase*3.1, fxPhase*1.7);
        float bend = fxNoise(q*0.28+vec2(3.7,-fxTime*0.16));
        vec2 flow = fxCurl(q+vec2(-fxTime*1.05,bend*1.2))*0.65 +
                    fxCurl(q*1.73+vec2(fxTime*0.48, -fxTime*0.72)+13.4)*0.35;
        flow /= max(1.0,length(flow));
        float trail = fxNoise(vec2(q.x*0.20-fxTime*0.45,q.y*0.32+bend));
        float gust = 0.35+0.65*smoothstep(0.3,0.72,trail);
        sampleUV += flow * gust * crown * amplitude / fxTextureSize;
    }
    vec4 pixel = texture2D(texture, sampleUV);
    if (fxWind > 0.0) {
        // Explicit subpixel sampling with alpha-aware color interpolation avoids
        // dark transparent fringes. Original alpha holds the outline still.
        vec2 p = sampleUV * fxTextureSize - 0.5;
        vec2 base = floor(p)+0.5, f = fract(p);
        vec4 blended = vec4(0.0);
        for (int y=0; y<2; ++y) {
            for (int x=0; x<2; ++x) {
                vec2 offset = vec2(float(x),float(y));
                vec2 weight = mix(1.0-f,f,offset);
                vec2 uv = clamp(base+offset,fxFrame.xy+0.5,fxFrame.xy+fxFrame.zw-0.5)/fxTextureSize;
                vec4 s = texture2D(texture,uv);
                blended += vec4(s.rgb*s.a,s.a)*weight.x*weight.y;
            }
        }
        pixel = vec4(blended.a>0.001 ? blended.rgb/blended.a : original.rgb,original.a);
    }
    // Avoid world reconstruction on unlit/no-position shader paths.
    pixel.rgb = fxIlluminate(pixel.rgb, fxLighting > 0.5 ? fxObjectWorld(sampleUV) : vec3(0.0));
    if (fogOpacity <= 0.0) {
        pixel.rgb += modelFrontVolume();
        gl_FragColor = pixel;
        return;
    }
    vec2 pixelDelta = v_pixelCoord - objectPixelAnchor;
    vec2 fogUV;
    float shadowMask = 1.0;
    if (useStandingPlane > 0.5) {
        vec3 world = standingPlaneWorld();
        vec2 shadowLocal = world.xy-fogWorldOrigin + max(world.z,0.0)*cloudHeightDirection;
        fogUV = (shadowLocal+fogWorldOffset)/fogTextureWorldSize;
    } else if (useModelPosition > 0.5) {
        vec2 texelUV = (floor(v_texCoord * modelPositionSize) + 0.5) /
                       modelPositionSize;
        vec4 surface = texture2D(modelPositionTexture, texelUV);
        float height = surfaceHeight(v_texCoord, surface);
        // The model is a rescaled, off-axis bake, not the map camera's mesh.
        // Solve the same camera ray as ground fog at its displayed height;
        // at height zero this is exactly the ground sample at this pixel.
        float rayX = (v_screenCoord.x - cameraCenter.x) / cameraFocal;
        float rayUp = -(v_screenCoord.y - cameraCenter.y) / cameraFocal;
        float directionY = -cameraSinPitch * rayUp - cameraCosPitch;
        float directionZ = cameraCosPitch * rayUp - cameraSinPitch;
        float rayZ = directionZ < 0.0 ? min(directionZ, -0.000001) :
                                       max(directionZ, 0.000001);
        float distance = (height - cameraHeight) / rayZ;
        float forward = distance * directionY;
        float lateral = distance * rayX;
        vec2 worldXZ = vec2(
            displayPosition.x + cameraCenter.x +
            cameraSinYaw * forward + cameraCosYaw * lateral,
            displayPosition.y + cameraCenter.y + cameraBack +
            cameraCosYaw * forward - cameraSinYaw * lateral);
        // Preserve the ground shader's operation order as well as its formula:
        // hard fog texel edges reveal even floating-point reassociation.
        height = max(cameraHeight + distance * directionZ, 0.0);
        vec2 local = worldXZ - fogWorldOrigin;
        vec2 shadowLocal = local + height * cloudHeightDirection;
        fogUV = (shadowLocal + fogWorldOffset) / fogTextureWorldSize;
        // Alpha 0 texels on the position bake carry no surface: a fully
        // translucent material would otherwise stamp garbage coordinates
        // sampled through the color bitmap's antialiased rim.
        shadowMask = step(0.02, surface.a);
    } else {
        fogUV = fogUVCenter +
                pixelDelta.x * fogUVPerPixelX +
                pixelDelta.y * fogUVPerPixelY;
    }
    vec4 cloud = texture2D(fogTexture, fract(fogUV));
    float shadowAlpha = clamp(cloud.a * fogOpacity, 0.0, 1.0);
    // Sample across the visible frame/model bounds instead of applying the
    // cloud value at one world anchor to the whole object. This keeps the
    // character/model alpha silhouette while allowing a cloud edge to cover
    // only part of it.
    if (softenEdges > 0.5) {
        // Edge softening: average the alpha of the four diagonal neighbours so
        // a cloud edge crossing a wall or roof reads as a soft gradient
        // instead of a razor line. The offset is one fog texel, not one
        // screen pixel, so the effect stays identical at any sprite scale.
        vec2 fogTexel = 1.0 / fogTextureWorldSize;
        float neighbourAlpha =
            (texture2D(fogTexture, fract(fogUV + vec2(fogTexel.x, fogTexel.y))).a +
             texture2D(fogTexture, fract(fogUV + vec2(fogTexel.x, -fogTexel.y))).a +
             texture2D(fogTexture, fract(fogUV + vec2(-fogTexel.x, fogTexel.y))).a +
             texture2D(fogTexture, fract(fogUV + vec2(-fogTexel.x, -fogTexel.y))).a) * 0.25;
        shadowAlpha = mix(shadowAlpha, neighbourAlpha, 0.5);
    }
    shadowAlpha *= shadowMask;
    vec3 cloudColor = mix(clamp(fxApplyTone(cloud.rgb), 0.0, 1.0), cloud.rgb, fxToneRestore);
    pixel.rgb = mix(pixel.rgb, cloudColor, shadowAlpha);
    // Atmospheric light in front of the opaque surface is not wall lighting
    // or cloud shadow. The background beam has already been covered by pixel.
    pixel.rgb += modelFrontVolume();
    gl_FragColor = pixel;
}
