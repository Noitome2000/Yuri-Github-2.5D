# Battle lifecycle bridge for MakerStudioPseudo3D.
# This file intentionally lives outside DBK/EBDX and leaves those plugins
# unchanged.  The overworld map renderer must be dormant during battle so its
# fullscreen projection shaders and OBJ surfaces cannot compete with EBDX.

module MakerStudioPseudo3DBattleCompatibility
  def pbStartBattle(*args)
    maker_p3d_suspend_overworld
    super
  end

  def pbEndBattle(*args)
    result = super
    maker_p3d_resume_overworld
    result
  ensure
    maker_p3d_resume_overworld if defined?(MakerStudioPseudo3D::Camera) &&
                                 MakerStudioPseudo3D::Camera.suspended?
  end

  private

  def maker_p3d_suspend_overworld
    return unless defined?(MakerStudioPseudo3D::Camera)
    return if MakerStudioPseudo3D::Camera.suspended?
    MakerStudioPseudo3D::Camera.suspend
    scene = defined?($scene) ? $scene : nil
    renderer = scene.map_renderer if scene && scene.respond_to?(:map_renderer)
    MakerStudioPseudo3D::Camera.dispose_state(renderer) if renderer
  end

  def maker_p3d_resume_overworld
    return unless defined?(MakerStudioPseudo3D::Camera)
    MakerStudioPseudo3D::Camera.resume if MakerStudioPseudo3D::Camera.suspended?
  end
end

if defined?(Battle::Scene) && !Battle::Scene.ancestors.include?(MakerStudioPseudo3DBattleCompatibility)
  Battle::Scene.prepend(MakerStudioPseudo3DBattleCompatibility)
end
