attribute vec2 position;
attribute vec2 texCoord;

varying vec2 v_texCoord;
varying vec2 v_pixelCoord;
varying vec2 v_screenCoord;

uniform mat4 projMat;
uniform mat4 spriteMat;
uniform vec2 texSizeInv;

void main() {
    gl_Position = projMat * spriteMat * vec4(position, 0.0, 1.0);
    v_texCoord = texCoord * texSizeInv;
    v_pixelCoord = texCoord;
    // Match fog_projection's viewport-local pixel coordinates, including
    // the final baked-model quad scale and its fractional placement.
    v_screenCoord = (spriteMat * vec4(position, 0.0, 1.0)).xy;
}
