varying vec2 v_texCoord;
uniform sampler2D texture;
uniform vec2 fxResolution;
uniform int fxPreset;
uniform float fxStrength;
uniform float fxBloom;
uniform float fxDof;
float luminance(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
    vec4 original = texture2D(texture, v_texCoord);
    if (fxStrength <= 0.0) { gl_FragColor = original; return; }
    vec3 c = original.rgb;
    vec3 glow = vec3(0.0);
    // Shared controls for both styles; preserve a sharp central focus band.
    if (fxBloom > 0.0 || fxDof > 0.0) {
        vec3 blur = vec3(0.0);
        float total = 0.0;
        vec2 stepUV = vec2(3.0) / fxResolution;
        for (int y = -2; y <= 2; ++y) {
            for (int x = -2; x <= 2; ++x) {
                vec2 offset = vec2(float(x), float(y));
                float weight = 1.0 / (1.0 + dot(offset, offset));
                vec2 uv = clamp(v_texCoord + offset * stepUV,
                                0.5 / fxResolution, 1.0 - 0.5 / fxResolution);
                vec3 sampleColor = texture2D(texture, uv).rgb;
                blur += sampleColor * weight;
                glow += sampleColor * smoothstep(0.18, 0.55, luminance(sampleColor)) * weight;
                total += weight;
            }
        }
        float focus = smoothstep(0.10, 0.40, abs(v_texCoord.y - 0.56));
        c = mix(c, blur / total, focus * min(fxDof * 2.5, 1.0));
        glow /= total;
    }
    if (fxPreset == 1) {
        // Soft daylight greens and lifted midtones, without neon saturation.
        c = pow(max(c, vec3(0.0)), vec3(0.72));
        c += 0.10 * c * (1.0 - c);
        float green = max(c.g - max(c.r, c.b), 0.0);
        c += vec3(green * 0.18, 0.0, green * 0.22);
        c = mix(vec3(luminance(c)), c, 1.06);
        c *= vec3(1.015, 1.01, 0.995);
    } else if (fxPreset == 2) {
        c = pow(max(c, vec3(0.0)), vec3(0.86));
        float l = luminance(c);
        c *= mix(vec3(0.88, 0.99, 1.18), vec3(1.13, 1.04, 0.88), smoothstep(0.15, 0.85, l));
        c *= (l + 0.20 * l * (1.0 - l)) / max(luminance(c), 0.0001);
        vec2 edge = (v_texCoord - 0.5) * 1.3;
        c *= 1.0 - dot(edge, edge) * 0.035;
    }
    // Screen blending rolls highlights off instead of clipping to white.
    c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - clamp(glow * fxBloom * 2.5, 0.0, 1.0));
    gl_FragColor = vec4(mix(original.rgb, c, fxStrength), original.a);
}
