attribute vec2 position;
uniform mat4 projMat;
uniform mat4 spriteMat;
varying vec2 v_screenCoord;
void main() {
    vec4 screen = spriteMat * vec4(position,0.0,1.0);
    gl_Position = projMat * screen;
    v_screenCoord = screen.xy;
}
