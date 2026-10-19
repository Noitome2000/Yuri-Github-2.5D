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
