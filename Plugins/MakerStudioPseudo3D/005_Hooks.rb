EventHandlers.add(:on_new_spriteset_map, :maker_studio_pseudo3d_create,
  proc { |spriteset, viewport|
    renderer = MakerStudioPseudo3D::Renderer.new(spriteset, viewport)
    spriteset.instance_variable_set(:@maker_studio_pseudo3d_renderer, renderer)
  })

class Spriteset_Map
  alias maker_studio_pseudo3d_update update unless method_defined?(:maker_studio_pseudo3d_update)
  def update
    maker_studio_pseudo3d_update
    @maker_studio_pseudo3d_renderer&.update
  end

  alias maker_studio_pseudo3d_dispose dispose unless method_defined?(:maker_studio_pseudo3d_dispose)
  def dispose
    @maker_studio_pseudo3d_renderer&.dispose
    @maker_studio_pseudo3d_renderer = nil
    maker_studio_pseudo3d_dispose
  end
end

class Game_Map
  def pseudo3d_blocked?(x, y)
    MakerStudioPseudo3D.collision_for(@map_id).key?([x, y])
  end

  alias pseudo3d_passable passable? unless method_defined?(:pseudo3d_passable)
  def passable?(x, y, d, self_event = nil)
    return false if pseudo3d_blocked?(x, y)
    pseudo3d_passable(x, y, d, self_event)
  end

  alias pseudo3d_player_passable playerPassable? unless method_defined?(:pseudo3d_player_passable)
  def playerPassable?(x, y, d, self_event = nil)
    return false if pseudo3d_blocked?(x, y)
    pseudo3d_player_passable(x, y, d, self_event)
  end

  alias pseudo3d_passable_strict passableStrict? unless method_defined?(:pseudo3d_passable_strict)
  def passableStrict?(x, y, d, self_event = nil)
    return false if pseudo3d_blocked?(x, y)
    pseudo3d_passable_strict(x, y, d, self_event)
  end
end

if $DEBUG
  MenuHandlers.add(:debug_menu, :pseudo3d_reload, {
    "name"        => _INTL("Reload Pseudo 3D Objects"),
    "parent"      => :maker_studio_menu,
    "description" => _INTL("Reload placed billboards and OBJ models from Maker Studio."),
    "effect"      => proc {
      MakerStudioPseudo3D.clear
      if $scene.respond_to?(:disposeSpritesets) && $scene.respond_to?(:createSpritesets)
        $scene.disposeSpritesets
        $scene.createSpritesets
      end
      pbMessage(_INTL("Pseudo 3D objects reloaded"))
    }
  })
end
