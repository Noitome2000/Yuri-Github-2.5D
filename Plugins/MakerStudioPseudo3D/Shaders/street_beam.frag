varying vec2 v_screenCoord;
uniform vec2 displayPosition;
uniform vec2 cameraCenter;
uniform float cameraBack;
uniform float cameraHeight;
uniform float cameraSinPitch;
uniform float cameraCosPitch;
uniform float cameraFocal;
uniform float cameraSinYaw;
uniform float cameraCosYaw;
uniform vec4 beamPosition;
uniform vec4 beamColor;
// outer/inner cosine, source ground elevation, visible volume opacity.
uniform vec4 beamShape;
uniform float beamBillboard;
uniform vec3 beamDirection;

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
void main() {
    float up = (cameraCenter.y - v_screenCoord.y) / cameraFocal;
    float lateral = (v_screenCoord.x - cameraCenter.x) / cameraFocal;
    float forward = -cameraSinPitch * up - cameraCosPitch;
    vec3 direction = vec3(cameraSinYaw*forward + cameraCosYaw*lateral,
        cameraCosYaw*forward - cameraSinYaw*lateral, cameraCosPitch*up-cameraSinPitch);
    float surfaceLimit = direction.z < -0.000001 ? -cameraHeight/direction.z : 1.0e20;
    if (occlusionEnabled > 0.5) surfaceLimit = terrainRayDistance(v_screenCoord,surfaceLimit);
    float alpha = streetVolume(direction, surfaceLimit, beamPosition, beamColor,
                               beamShape, beamBillboard, beamDirection);
    if (alpha <= 0.0) discard;
    gl_FragColor = vec4(beamColor.rgb, alpha);
}
