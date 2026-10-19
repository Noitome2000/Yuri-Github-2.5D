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
uniform vec2 mapOrigin;
uniform vec2 mapSize;
uniform vec2 textureWorldSize;
uniform vec2 textureOffset;
uniform vec2 cloudHeightDirection;
uniform float playerFootY;
uniform float tileSize;
uniform float maxTerrainHeight;
uniform float layerOpacity;
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

void main() {
    vec2 screen = v_screenUV * screenSize;
    float rayX = (screen.x - cameraCenter.x) / cameraFocal;
    float rayUp = -(screen.y - cameraCenter.y) / cameraFocal;
    float directionY = -cameraSinPitch * rayUp - cameraCosPitch;
    float directionZ = cameraCosPitch * rayUp - cameraSinPitch;
    if (directionZ >= -0.000001)
        discard;

    // Use the same fast top-surface solve as terrain_projection. A fog ray
    // that crosses a height discontinuity is refined below so it shades the
    // wall itself instead of the ground behind it.
    float seedHeight = clamp(maxTerrainHeight, 0.0, cameraHeight - 0.001);
    float rayDistance = (seedHeight - cameraHeight) / directionZ;
    vec2 world = vec2(0.0);
    vec4 terrain = vec4(0.0);
    bool converged = false;
    bool touchedAuthored = false;
    for (int iteration = 0; iteration < 4; ++iteration) {
        float forward = rayDistance * directionY;
        float lateral = rayDistance * rayX;
        world.x = displayPosition.x + cameraCenter.x +
                  cameraSinYaw * forward + cameraCosYaw * lateral;
        world.y = displayPosition.y + cameraCenter.y + cameraBack +
                  cameraCosYaw * forward - cameraSinYaw * lateral;
        if (!atlasContains(world))
            discard;
        terrain = texture2D(terrainData, atlasUV(world));
        touchedAuthored = touchedAuthored || terrain.b > 0.5;
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
    if (!atlasContains(world))
        discard;
    terrain = texture2D(terrainData, atlasUV(world));
    float elevation = terrain.r * 255.0;

    float groundDistance = -cameraHeight / directionZ;
    float groundForward = groundDistance * directionY;
    float groundLateral = groundDistance * rayX;
    vec2 groundWorld = vec2(
        displayPosition.x + cameraCenter.x +
        cameraSinYaw * groundForward + cameraCosYaw * groundLateral,
        displayPosition.y + cameraCenter.y + cameraBack +
        cameraCosYaw * groundForward - cameraSinYaw * groundLateral
    );
    vec2 rayBoundsMin = min(world, groundWorld);
    vec2 rayBoundsMax = max(world, groundWorld);
    bool mayCrossTerrain = !(rayBoundsMax.x < terrainBounds.x ||
                             rayBoundsMin.x > terrainBounds.z ||
                             rayBoundsMax.y < terrainBounds.y ||
                             rayBoundsMin.y > terrainBounds.w);

    if (!converged || touchedAuthored ||
        (mayCrossTerrain && (terrain.b <= 0.5 || elevation < 0.25))) {
        const int HEIGHT_SLICES = 10;
        float previousHeight = seedHeight;
        bool found = false;
        for (int slice = 0; slice <= HEIGHT_SLICES; ++slice) {
            float fraction = float(slice) / float(HEIGHT_SLICES);
            float sampleHeight = seedHeight * (1.0 - fraction);
            float sampleDistance = (sampleHeight - cameraHeight) / directionZ;
            float sampleForward = sampleDistance * directionY;
            float sampleLateral = sampleDistance * rayX;
            vec2 sampleWorld = vec2(
                displayPosition.x + cameraCenter.x +
                cameraSinYaw * sampleForward + cameraCosYaw * sampleLateral,
                displayPosition.y + cameraCenter.y + cameraBack +
                cameraCosYaw * sampleForward - cameraSinYaw * sampleLateral
            );
            vec4 sampleTerrain = vec4(0.0);
            bool inside = false;
            if (atlasContains(sampleWorld)) {
                sampleTerrain = texture2D(terrainData, atlasUV(sampleWorld));
                float sampleElevation = sampleTerrain.r * 255.0;
                inside = sampleHeight <= 0.001 ||
                         (sampleTerrain.b > 0.5 && sampleElevation >= 0.25 &&
                          sampleElevation + 0.25 >= sampleHeight);
            }
            if (inside) {
                float insideHeight = sampleHeight;
                float outsideHeight = previousHeight;
                vec2 insideWorld = sampleWorld;
                vec4 insideTerrain = sampleTerrain;
                if (slice > 0) {
                    for (int refinement = 0; refinement < 4; ++refinement) {
                        float middleHeight = (outsideHeight + insideHeight) * 0.5;
                        float middleDistance = (middleHeight - cameraHeight) / directionZ;
                        float middleForward = middleDistance * directionY;
                        float middleLateral = middleDistance * rayX;
                        vec2 middleWorld = vec2(
                            displayPosition.x + cameraCenter.x +
                            cameraSinYaw * middleForward + cameraCosYaw * middleLateral,
                            displayPosition.y + cameraCenter.y + cameraBack +
                            cameraCosYaw * middleForward - cameraSinYaw * middleLateral
                        );
                        vec4 middleTerrain = vec4(0.0);
                        bool middleInside = false;
                        if (atlasContains(middleWorld)) {
                            middleTerrain = texture2D(terrainData, atlasUV(middleWorld));
                            float middleElevation = middleTerrain.r * 255.0;
                            middleInside = middleHeight <= 0.001 ||
                                           (middleTerrain.b > 0.5 &&
                                            middleElevation >= 0.25 &&
                                            middleElevation + 0.25 >= middleHeight);
                        }
                        if (middleInside) {
                            insideHeight = middleHeight;
                            insideWorld = middleWorld;
                            insideTerrain = middleTerrain;
                        } else {
                            outsideHeight = middleHeight;
                        }
                    }
                }
                world = insideWorld;
                terrain = insideTerrain;
                elevation = terrain.r * 255.0;
                rayDistance = (insideHeight - cameraHeight) / directionZ;
                found = true;
                break;
            }
            previousHeight = sampleHeight;
        }
        if (!found)
            discard;
    }

    bool overpass = terrain.g > 0.5;
    bool authored = terrain.b > 0.5 && elevation >= 0.25;
    float cellNorth = floor(world.y / tileSize) * tileSize;
    bool foreground = authored && cellNorth >= playerFootY - 0.5;
    if (renderMode == 0 && (overpass || foreground))
        discard;
    if (renderMode == 1 && (overpass || !foreground))
        discard;
    if (renderMode == 2 && !overpass)
        discard;
    vec2 local = world - mapOrigin;
    if (local.x < 0.0 || local.y < 0.0 ||
        local.x >= mapSize.x || local.y >= mapSize.y)
        discard;

    forward = rayDistance * directionY;
    float forwardDistance = -forward;
    if (forwardDistance > farDistance)
        discard;
    // On a wall, terrain.r is the column's top, not the ray hit height.
    // Use the actual surface hit so the wall joins both the ground and roof.
    float surfaceHeight = max(cameraHeight + rayDistance * directionZ, 0.0);
    vec2 shadowLocal = local + surfaceHeight * cloudHeightDirection;
    vec2 fogUV = fract((shadowLocal + textureOffset) / textureWorldSize);
    vec4 pixel = texture2D(texture, fogUV);
    // Custom shader sprites do not have to expose RGSS opacity to user GLSL.
    // Apply the source Plane opacity explicitly so native fog keeps the
    // tileset-authored alpha (clouds3 uses 128/255) after ground projection.
    pixel.a *= clamp(layerOpacity, 0.0, 1.0);
    if (forwardDistance > fadeStart)
        pixel.a *= clamp((farDistance - forwardDistance) /
                         max(farDistance - fadeStart, 0.0001), 0.0, 1.0);
    gl_FragColor = pixel;
}
