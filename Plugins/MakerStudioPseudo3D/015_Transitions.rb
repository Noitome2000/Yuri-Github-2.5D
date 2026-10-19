# Prepare the first complete projected view under a cover, before the caller's
# native fade/transition reveals it. Covers new games, loads and map transfers.
module MakerStudioPseudo3D
  module Transitions
    PREPARE_TIMEOUT = 10.0

    class Cover
      def initialize
        @bitmap = Graphics.snap_to_bitmap
        @viewport = Viewport.new(0, 0, Graphics.width, Graphics.height)
        @viewport.z = 99_980
        @sprite = Sprite.new(@viewport)
        @sprite.bitmap = @bitmap
      rescue Exception
        dispose
        raise
      end

      def dispose
        @sprite.dispose if @sprite && !@sprite.disposed?
        @bitmap.dispose if @bitmap && !@bitmap.disposed?
        @viewport.dispose if @viewport && !@viewport.disposed?
      end
    end

    def self.prepare(scene)
      stable = 0
      # Only update render objects here. New autoruns, movement and encounters
      # must wait until the normal map loop resumes. pbWait owns event pumping.
      pbPushFade
      begin
        Camera.with_transition_preparation do
          pbWait(PREPARE_TIMEOUT) do
            break unless $scene.equal?(scene)
            scene.updateSpritesets
            stable = Camera.transition_ready?(scene.map_renderer) ? stable + 1 : 0
            break if stable >= 2 # receivers bind the new terrain on the next update
          end
        end
      ensure
        pbPopFade
      end
      ready = stable >= 2 && $scene.equal?(scene)
      Console.echo_error('Pseudo3D scene preparation timed out') if !ready && $scene.equal?(scene)
      ready
    end
  end

  module ScenePreparation
    def createSpritesets
      return super unless Camera.enabled? && $game_map
      return super if @maker_p3d_preparing_scene
      @maker_p3d_preparing_scene = true
      cover = nil
      begin
        cover = Transitions::Cover.new
        result = Camera.with_transition_preparation { super }
        Transitions.prepare(self)
        result
      ensure
        cover&.dispose
        @maker_p3d_preparing_scene = false
      end
    end
  end
end
Scene_Map.prepend(MakerStudioPseudo3D::ScenePreparation)
