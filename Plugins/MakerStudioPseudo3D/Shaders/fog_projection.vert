attribute vec2 position;
attribute vec2 texCoord;

varying vec2 v_screenUV;

uniform mat4 projMat;
uniform mat4 spriteMat;
uniform vec2 texSizeInv;

void main() {
    gl_Position = projMat * spriteMat * vec4(position, 0.0, 1.0);
    v_screenUV = position * texSizeInv;
}
