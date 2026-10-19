// Stub vertex stage for model_position.frag. The real geometry comes from
// mkxp-z-ext's built-in model3d.vert during Model3D bakes; this stub only
// exists so the Shader class can build its sprite/viewport program pair from
// the same fragment source (matching varyings, placeholder values).
attribute vec2 position;
attribute vec2 texCoord;

varying vec2 v_texCoord;
varying vec3 v_fragPos;

uniform mat4 projMat;
uniform mat4 spriteMat;
uniform vec2 texSizeInv;

void main() {
    gl_Position = projMat * spriteMat * vec4(position, 0.0, 1.0);
    v_texCoord = texCoord * texSizeInv;
    v_fragPos = vec3(0.0);
}
