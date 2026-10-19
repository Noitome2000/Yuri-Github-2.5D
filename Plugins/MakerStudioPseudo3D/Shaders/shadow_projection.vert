attribute vec2 position;
attribute vec2 texCoord;

varying vec2 v_texCoord;

uniform mat4 projMat;
uniform vec2 texSizeInv;
uniform vec2 cameraCenter;
uniform vec2 displayPosition;
uniform float cameraBack;
uniform float cameraHeight;
uniform float cameraSinPitch;
uniform float cameraCosPitch;
uniform float cameraFocal;
uniform float cameraSinYaw;
uniform float cameraCosYaw;
uniform vec3 world0;
uniform vec3 world1;
uniform vec3 world2;
uniform vec3 world3;

void main() {
    vec2 local = clamp(position * texSizeInv, 0.0, 1.0);
    vec3 top = mix(world0, world1, local.x);
    vec3 bottom = mix(world3, world2, local.x);
    vec3 world = mix(top, bottom, local.y);
    float cameraWorldX = displayPosition.x + cameraCenter.x;
    float cameraWorldY = displayPosition.y + cameraCenter.y + cameraBack;
    float dx = world.x - cameraWorldX;
    float dy = world.y - cameraWorldY;
    float lateral = cameraCosYaw * dx - cameraSinYaw * dy;
    float forward = cameraSinYaw * dx + cameraCosYaw * dy;
    float dz = world.z - cameraHeight;
    float depth = -cameraCosPitch * forward - cameraSinPitch * dz;
    float vertical = -cameraSinPitch * forward + cameraCosPitch * dz;
    vec2 screen = vec2(cameraCenter.x + cameraFocal * lateral / max(depth, 0.001),
                       cameraCenter.y - cameraFocal * vertical / max(depth, 0.001));
    gl_Position = projMat * vec4(screen, 0.0, 1.0);
    v_texCoord = texCoord * texSizeInv;
}
