module MakerStudioPseudo3D
  # A deliberately small renderer: Model3D produces the complete textured
  # bitmap; Sprite corners performs the Mod7-style world-to-screen quad.
  class ModelVisual
    def initialize(viewport, instance, model, map, placement = nil)
      @instance, @model, @map = instance, model, map
      @sprite = Sprite.new(viewport)
      @sprite.instance_variable_set(:@p3d_walk_model_id, ModelOcclusion.participates?(instance,model) ? instance['id'] : nil)
      @surface = nil
      @billboard = load_billboard
      @bitmap = nil
      refresh(placement)
    end

    # Use the existing conservative rejection before allocating a Sprite or
    # loading a Model3D. Return the projection so visible models compute it once.
    def self.project_model(instance, model, map)
      return nil unless defined?(Camera)
      dx = map.display_x.to_f / Game_Map::X_SUBPIXELS
      dy = map.display_y.to_f / Game_Map::Y_SUBPIXELS
      fw = [(instance["footprintW"] || model["footprintW"] || 1).to_f, 1.0].max * TILE_SIZE
      fd = [(instance["footprintD"] || model["footprintD"] || 1).to_f, 1.0].max * TILE_SIZE
      world_x = instance["x"].to_f + fw / 2.0
      world_y = instance["y"].to_f + fd / 2.0
      x = world_x - dx
      y = world_y - dy
      elevation = 0.0
      if defined?(MakerStudio) && MakerStudio.respond_to?(:terrain_height_at_pixel)
        elevation = MakerStudio.terrain_height_at_pixel(map.map_id, x + dx, y + dy).to_f
      end
      elevation += instance['elevation'].to_f.clamp(-2048,2048)
      elevation = model["batchElevation"] if model.key?("batchElevation")
      scale = [[(instance["scale"] || 1).to_f, 0.1].max, 8.0].min
      rotation = (instance["rotation"] || 0).to_f
      projected = Camera.project_point(x, y, elevation)
      return nil unless projected
      projected_x, projected_y, perspective_scale = projected
      estimated_height = [(model["pixelHeight"] || DEFAULT_HEIGHT).to_f *
                          scale * perspective_scale, 1.0].max
      estimated_width = [[fw, fd].max * scale * perspective_scale, 1.0].max
      margin = CULL_MARGIN.to_f + [estimated_width, estimated_height].max
      return nil if projected_x < -margin || projected_x > Graphics.width + margin ||
                     projected_y < -margin || projected_y > Graphics.height + margin
      [fw, fd, world_x, world_y, x, y, elevation, scale, rotation, projected]
    end

    def refresh(placement = nil)
      return refresh_billboard if @model["type"] == "billboard"
      placement ||= self.class.project_model(@instance, @model, @map)
      return hide unless placement
      fw, fd, world_x, world_y, x, y, elevation, scale, rotation, projected = placement
      projected_x, projected_y, perspective_scale = projected

      @surface ||= NativeRenderer.create_surface(@model)
      return hide unless @surface
      @surface.model_occlusion = ModelOcclusion.participates?(@instance,@model)
      @surface.update_animation(@instance['walkable'] != true && @instance['animationEnabled'] != false,
        Process.clock_gettime(Process::CLOCK_MONOTONIC), @instance['animationSpeed'])
      bitmap = @surface.render_world(rotation, x, y, scale, Camera.camera_values,
                                     elevation, world_x, world_y, @map.map_id)
      return hide unless bitmap && !bitmap.disposed?
      @bitmap = bitmap
      @sprite.bitmap = bitmap unless @sprite.bitmap == bitmap
      source_rect = @surface.source_rect || Rect.new(0, 0, bitmap.width, bitmap.height)
      @sprite.src_rect.set(source_rect.x, source_rect.y,
                           source_rect.width, source_rect.height)
      @sprite.x = 0
      @sprite.y = 0
      @sprite.zoom_x = 1.0
      @sprite.zoom_y = 1.0
      ground_unit_px = @surface.ground_unit_px
      ground_center_px = @surface.ground_center_px
      ground_base_px = @surface.ground_base_px
      if ground_unit_px && ground_unit_px > 0.0001 && ground_center_px &&
         ground_base_px && source_rect.width > 0 && source_rect.height > 0
        # Calibrate the quad on the bake's ground plane. The quad is flat while
        # the bitmap already contains perspective, so exactly one depth plane
        # can be reproduced at the correct size; it has to be the ground, where
        # the model meets the map and where a mismatch opens seams. Using the
        # bbox centre plane instead oversized the quad by 13-25%, and matching
        # the projected width of the ground face made the model breathe by ~10%
        # as the camera passed it.
        bake_px = @surface.world_unit_px.to_f / ground_unit_px *
                  scale * perspective_scale
        projected_width = [source_rect.width * bake_px, 1.0].max
        projected_height = [source_rect.height * bake_px, 1.0].max
        # Anchor on the ground face, not on the crop box: the crop top follows
        # the roof, so anchoring there would move the base whenever the lean
        # changed.
        left = projected_x - (ground_center_px - source_rect.x) * bake_px
        right = left + projected_width
        # project_point places the anchor at the front edge of the footprint,
        # which is the near edge of the ground face in the bake. Any crop
        # padding below it then lands below the anchor automatically.
        bottom = projected_y + (source_rect.y + source_rect.height -
                                ground_base_px) * bake_px
      else
        # No bake metrics yet. Use the mesh extents rather than the footprint:
        # footprintW/D describe grid occupancy, and a mesh narrower or shallower
        # than its cell would be stretched to fill the whole tile.
        radians = rotation * Math::PI / 180.0
        projected_width = [(@surface.mesh_width_px.to_f * Math.cos(radians).abs +
                            @surface.mesh_depth_px.to_f * Math.sin(radians).abs) *
                           scale * perspective_scale, 1.0].max
        projected_height = [(@model["pixelHeight"] || DEFAULT_HEIGHT).to_f *
                            scale * perspective_scale, 1.0].max
        left = projected_x - projected_width / 2.0
        right = projected_x + projected_width / 2.0
        bottom = projected_y
      end
      ground_offset = (MapSettings.value(:MODEL_GROUND_OFFSET_PIXELS) rescue 0.0).to_f
      bottom += ground_offset
      top = bottom - projected_height
      corners = [left, top, right, top, right, bottom, left, bottom]
      if @sprite.respond_to?(:corners=)
        @sprite.corners = corners
      else
        # A stock RGSS/MKXP runtime cannot draw arbitrary sprite vertices. Keep
        # the baked model usable as an axis-aligned fallback there.
        @sprite.ox = source_rect.width / 2
        @sprite.oy = source_rect.height
        @sprite.x = corners[0]
        @sprite.y = corners[1]
        @sprite.zoom_x = (corners[2] - corners[0]).abs / [source_rect.width, 1].max
        @sprite.zoom_y = (corners[5] - corners[3]).abs / [source_rect.height, 1].max
      end
      @sprite.opacity = [(@instance["opacity"] || 255).to_i, 255].min
      @sprite.visible = @instance["visible"] != false && @sprite.opacity > 0
      @sprite.z = (Camera.ground_sort_z(x, y, 0.0, elevation) || 0).round + 1
      if ModelOcclusion.participates?(@instance,@model)
        # Terrain is -80. Resolve solid furniture behind native foot-sorted
        # sprites using mesh depth, without promoting any individual actor.
        @sprite.z = -40
      else
        @sprite.instance_variable_set(:@p3d_anchor_depth_scale,1.0/perspective_scale)
      end
      # Use the same live outdoor tone as tiles/characters. MKXP applies it
      # after the object shader; the shared viewport owns screen tone/post FX.
      pbDayNightTint(@sprite)
      Camera.apply_lighting_tone(@sprite) if Camera.respond_to?(:apply_lighting_tone)
      if Camera.respond_to?(:apply_object_fog) &&
         Camera.respond_to?(:object_fog_screen_mapping)
        fog_mapping = Camera.object_fog_screen_mapping(x, y, elevation, @sprite,
                                                        source_rect, corners)
        Camera.apply_object_fog(@sprite, @map.map_id, world_x, world_y, fw, fd,
                                [source_rect.x, source_rect.y,
                                 source_rect.width, source_rect.height],
                                fog_mapping, @surface.surface_mapping)
      end
      :rendered
    rescue => e
      Console.echo_error("Pseudo3D model: #{e.message}") if defined?(Console)
      hide
    end

    def refresh_billboard
      return hide unless @billboard && !@billboard.disposed?
      Camera.restore_sprite(@sprite) if defined?(Camera)
      dx = @map.display_x.to_f / Game_Map::X_SUBPIXELS
      dy = @map.display_y.to_f / Game_Map::Y_SUBPIXELS
      fw = [(@instance["footprintW"] || 1).to_f, 1.0].max * TILE_SIZE
      fd = [(@instance["footprintD"] || 1).to_f, 1.0].max * TILE_SIZE
      @sprite.bitmap = @billboard
      @sprite.ox = @billboard.width / 2
      @sprite.oy = @billboard.height
      @sprite.x = @instance["x"].to_f + fw / 2.0 - dx
      @sprite.y = @instance["y"].to_f + fd - dy
      world_scale = [[(@instance["scale"] || 1).to_f, 0.1].max, 8.0].min *
                    (@model['pixelHeight'] || @billboard.height).to_f / @billboard.height
      @sprite.zoom_x = @sprite.zoom_y = world_scale
      @sprite.visible = @instance["visible"] != false
      @sprite.z = @sprite.y.to_i + 1
      @sprite.opacity = [[(@instance['opacity'] || 255).to_i, 0].max, 255].min
      pbDayNightTint(@sprite)
      @sprite.instance_variable_set(:@p3d_wind, @instance['wind'].nil? ? @model['wind'] == true : @instance['wind'] == true)
      @sprite.instance_variable_set(:@p3d_world_scale, world_scale)
      if defined?(Camera)
        world_x = @instance['x'].to_f + fw / 2.0
        world_y = @instance['y'].to_f + fd
        elevation = defined?(VisualEffects) ? VisualEffects.elevation(@map, world_x, world_y) : 0.0
        elevation = @model['batchElevation'] if @model.key?('batchElevation')
        Camera.apply_standing_sprite(@sprite, @sprite.y, 1.0, elevation)
        base = @sprite.instance_variable_get(:@maker_p3d_projection_base)
        @sprite.instance_variable_set(:@p3d_anchor_depth_scale,
          base ? base[3].to_f.abs/[@sprite.zoom_y.abs,0.0001].max : 1.0)
        Camera.apply_lighting_tone(@sprite)
        Camera.apply_object_fog(@sprite, @map.map_id, world_x, world_y, fw, fd)
      end
      :rendered
    end

    def load_billboard
      return nil unless @model["type"] == "billboard"
      return StaticBatches.billboard_bitmap(@model) if @model['batchParts']
      path = MakerStudioPseudo3D.image_path(@model)
      path && File.exist?(path) ? Bitmap.new(path) : nil
    rescue
      nil
    end

    def hide
      @sprite.visible = false unless @sprite.disposed?
      :failed
    end

    def dispose
      Camera.clear_object_fog(@sprite) if defined?(Camera) &&
                                           Camera.respond_to?(:clear_object_fog)
      unless @sprite.disposed?
        @sprite.corners = nil if @sprite.respond_to?(:corners=)
        @sprite.bitmap = nil
        @sprite.dispose
      end
      @surface.dispose if @surface
      @billboard.dispose if @billboard && !@billboard.disposed?
    end
  end

  class Renderer
    def initialize(spriteset, viewport)
      @map, @viewport = spriteset.map, viewport
      @visuals = {}
      @scene = MakerStudioPseudo3D.scene(@map.map_id)
      @disposed = false
      build_index
      update
    end

    def build_index
      @records = {}
      return unless @scene
      (@scene["instances"] || []).each do |instance|
        model = MakerStudioPseudo3D.asset(instance["assetId"])
        @records[instance["id"]] = [instance, model] if model
      end
    end

    def update
      return if @disposed || !@scene
      wanted = {}
      @records.each do |id, (instance, model)|
        next if instance["visible"] == false
        wanted[id] = true
        visual = @visuals[id]
        placement = nil
        if model['type'] == 'model'
          placement = ModelVisual.project_model(instance, model, @map)
          unless placement
            visual.hide if visual
            next
          end
        end
        if visual
          visual.refresh(placement)
        else
          # Construction already performs the first refresh.
          @visuals[id] = ModelVisual.new(@viewport, instance, model, @map, placement)
        end
      end
      (@visuals.keys - wanted.keys).each { |id| @visuals.delete(id).dispose }
    end

    def dispose
      return if @disposed
      @disposed = true
      @visuals.each_value(&:dispose)
      @visuals.clear
      MakerStudioPseudo3D.release_renderer if MakerStudioPseudo3D.respond_to?(:release_renderer)
    end
  end
end
