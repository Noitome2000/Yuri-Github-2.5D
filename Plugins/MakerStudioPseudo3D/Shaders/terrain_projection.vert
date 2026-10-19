attribute vec2 position;
attribute vec2 texCoord;

varying vec2 v_texCoord;
varying vec2 v_screenUV;

uniform mat4 projMat;
uniform mat4 spriteMat;
uniform vec2 texSizeInv;

void main() {
    gl_Position = projMat * spriteMat * vec4(position, 0.0, 1.0);
    v_texCoord = texCoord * texSizeInv;
    v_screenUV = position * texSizeInv;
}
