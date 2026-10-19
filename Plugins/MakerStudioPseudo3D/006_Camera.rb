# frozen_string_literal: true

module MakerStudioPseudo3D
  module Camera
    CHUNK_TILES = 8
    CHUNK_SIZE = CHUNK_TILES * TILE_SIZE
    CHUNK_CACHE_LIMIT = CAMERA_CHUNK_CACHE
    SCANLINE_HEIGHT = CAMERA_SCANLINE_HEIGHT
    FAR_DISTANCE = CAMERA_FAR_TILES * TILE_SIZE.to_f
    REFERENCE_PITCH_DEGREES = 28.0
    OVERPASS_LAYER_Z = 5000
    GROUND_SHADER_PATH =
      "Plugins/MakerStudioPseudo3D/Shaders/ground_projection.frag"
    TERRAIN_SHADER_PATH =
      "Plugins/MakerStudioPseudo3D/Shaders/terrain_projection.frag"
    FOG_SHADER_PATH =
      "Plugins/MakerStudioPseudo3D/Shaders/fog_projection.frag"
    OBJECT_FOG_SHADER_PATH =
      "Plugins/MakerStudioPseudo3D/Shaders/object_fog.frag"
    SHADOW_SHADER_PATH =
      "Plugins/MakerStudioPseudo3D/Shaders/shadow_projection.frag"

    @enabled = CAMERA_ENABLED
    # Battle scenes create a second, full-screen renderer while the map
    # spriteset can remain alive during transitions.  Keep the map camera
    # dormant for the duration of a battle so its projection shaders and
    # off-screen atlases cannot compete with EBDX animations.
    @suspend_depth = 0
    @camera_values = nil
    @camera_signature = nil

    class << self
      def enabled?
        return false if @suspend_depth.to_i > 0
        map_id = MapSettings.current_map_id
        @map_override = nil if @map_override && @map_override[0] != map_id
        return @map_override[1] if @map_override
        mode = MapSettings.mode(map_id)
        return mode == '2.5D' if mode
        @enabled
      end

      def hide_panorama?
        enabled? && !(MapSettings.value(:CAMERA_SHOW_PANORAMA) rescue true)
      end

      def suspend
        @suspend_depth = @suspend_depth.to_i + 1
      end

      def resume
        @suspend_depth = [@suspend_depth.to_i - 1, 0].max
      end

      def suspended?
        @suspend_depth.to_i > 0
      end

      def projection_shader_available?
        defined?(Shader) && Sprite.instance_methods.include?(:shader=) &&
          File.exist?(GROUND_SHADER_PATH) && File.exist?(TERRAIN_SHADER_PATH)
      end

      def toggle
        @map_override = [MapSettings.current_map_id, !enabled?]
      end

      def far_distance
        MapSettings.value(:CAMERA_FAR_TILES).to_f * TILE_SIZE
      end

      # Only callers holding an opaque transition cover may widen the build
      # budget. Ordinary movement keeps the existing one-chunk-per-frame path.
      def with_transition_preparation
        @transition_prepare_depth = @transition_prepare_depth.to_i + 1
        yield
      ensure
        @transition_prepare_depth = [@transition_prepare_depth.to_i - 1, 0].max
      end

      def transition_preparing?
        @transition_prepare_depth.to_i > 0
      end

      def transition_ready?(renderer)
        return true unless enabled?
        return false unless renderer && !renderer.disposed? && $game_map
        state = renderer.instance_variable_get(:@maker_p3d_mode7)
        return false unless state && state[:rendered_view_valid]
        view = state[:rendered_view]
        return false unless view && view[0].equal?($game_map) &&
                            view[1] == $game_map.display_x &&
                            view[2] == $game_map.display_y &&
                            view[3].equal?(camera_values)
        return true unless ground_shader_active?(state)
        return false if state[:ground_atlas_pending] || state[:terrain_data_pending]
        atlas = state[:ground_atlas]
        texture = state[:terrain_data_texture]
        atlas && !atlas.disposed? && texture && !texture.disposed? &&
          state[:terrain_render_atlas].equal?(atlas) && state[:terrain_data_key] &&
          state[:ground_atlas_origin] == state[:terrain_render_origin] &&
          state[:terrain_data_origin] == state[:terrain_render_origin] &&
          state[:ground_atlas_key] == state[:terrain_render_atlas_key] &&
          state[:terrain_data_atlas_key] == state[:terrain_render_atlas_key]
      end

      def camera_values
        width = Graphics.width
        height_px = Graphics.height
        # A menu changes the canvas, not the map lens. Deriving focal length
        # and camera altitude from its taller framebuffer zoomed/rebaked the
        # whole world on entry. Only a real map-resolution change changes lens.
        lens_height = height_px
        # for_map returns an immutable configuration, replaced by load! on
        # edits. Cache across calls, including multiple renders in one frame;
        # a settings reload or canvas change invalidates it immediately.
        settings = MapSettings.for_map
        if @camera_values && @camera_settings.equal?(settings) &&
           @camera_width == width && @camera_height == height_px &&
           @camera_lens_height == lens_height
          return @camera_values
        end
        @camera_settings = settings
        @camera_width, @camera_height = width, height_px
        @camera_lens_height = lens_height
        signature = [
          width, height_px, lens_height, MapSettings.value(:CAMERA_PITCH_DEGREES).to_f,
          MapSettings.value(:CAMERA_HORIZON_RATIO).to_f, MapSettings.value(:CAMERA_TARGET_RATIO).to_f,
          MapSettings.value(:CAMERA_FOCAL_LENGTH_RATIO).to_f,
          CAMERA_SCANLINE_HEIGHT.to_i, MapSettings.value(:CAMERA_FAR_TILES).to_f
        ]
        return @camera_values if @camera_values && @camera_signature == signature
        target_y = Graphics.height * MapSettings.value(:CAMERA_TARGET_RATIO)
        pitch_degrees = effective_pitch_degrees
        pitch = pitch_degrees * Math::PI / 180.0
        reference_pitch = REFERENCE_PITCH_DEGREES * Math::PI / 180.0
        sin_pitch = Math.sin(pitch)
        cos_pitch = Math.cos(pitch)
        base_span = [lens_height * (MapSettings.value(:CAMERA_TARGET_RATIO) -
                                   MapSettings.value(:CAMERA_HORIZON_RATIO)), 1.0].max
        # CAMERA_HORIZON_RATIO defines the horizon at the reference pitch.
        # Keep the focal length fixed while pitching the camera. This makes the
        # angle monotonic and prevents close models from stretching at low angles.
        focal_ratio = MapSettings.value(:CAMERA_FOCAL_LENGTH_RATIO).to_f
        focal = if focal_ratio > 0.0
                  lens_height * [focal_ratio, 0.1].max
                else
                  base_span / Math.tan(reference_pitch)
                end
        height = focal * sin_pitch
        back = focal * cos_pitch
        horizon_y = target_y - focal * Math.tan(pitch)
        values = {
          center_x: Graphics.width / 2.0,
          center_y: target_y,
          horizon_y: horizon_y,
          sin_pitch: sin_pitch,
          cos_pitch: cos_pitch,
          height: height,
          back: back,
          focal: focal,
          # Keep the world camera fixed.  Map scrolling changes which part of
          # the projected world reaches the screen; turning the player must not
          # rerender every OBJ or rotate the ground atlas.
          sin_yaw: 0.0,
          cos_yaw: 1.0
        }
        values[:rows] = projection_rows(values)
        @camera_signature = signature
        @camera_values = values
      end

      def projection_rows(camera)
        rows = []
        screen_y = [camera[:horizon_y].floor, 0].max
        while screen_y < Graphics.height
          strip_height = [SCANLINE_HEIGHT, Graphics.height - screen_y].min
          sample_y = screen_y + strip_height / 2.0
          ray_up = -(sample_y - camera[:center_y]) / camera[:focal]
          direction_y = -camera[:sin_pitch] * ray_up - camera[:cos_pitch]
          direction_z = camera[:cos_pitch] * ray_up - camera[:sin_pitch]
          if direction_z < -0.000001
            distance = -camera[:height] / direction_z
            world_y = camera[:center_y] + camera[:back] + distance * direction_y
            forward_distance = camera[:center_y] + camera[:back] - world_y
            if forward_distance <= far_distance
              left_world = camera[:center_x] +
                           distance * ((0.0 - camera[:center_x]) / camera[:focal])
              right_world = camera[:center_x] +
                            distance * ((Graphics.width - camera[:center_x]) / camera[:focal])
              fade_start = far_distance * 0.86
              opacity = if forward_distance > fade_start
                          ((far_distance - forward_distance) * 255 /
                            (far_distance - fade_start)).round
                        else
                          255
                        end
              rows << [screen_y, strip_height, world_y, left_world, right_world,
                       [[opacity, 0].max, 255].min]
            end
          end
          screen_y += strip_height
        end
        rows
      end

      def effective_pitch_degrees
        [[MapSettings.value(:CAMERA_PITCH_DEGREES).to_f, 1.0].max, 89.0].min
      end

      # Forward projection used by every upright sprite. The inverse of this
      # same camera is used below to sample the ground texture scanlines.
      def project_point(x, y, elevation = 0.0)
        camera = camera_values
        dx = x.to_f - camera[:center_x]
        dy = y.to_f - (camera[:center_y] + camera[:back])
        lateral = camera[:cos_yaw] * dx - camera[:sin_yaw] * dy
        forward = camera[:sin_yaw] * dx + camera[:cos_yaw] * dy
        dz = elevation.to_f - camera[:height]
        depth = (-camera[:cos_pitch] * forward) - (camera[:sin_pitch] * dz)
        return nil if depth <= 0.001
        vertical = (-camera[:sin_pitch] * forward) + (camera[:cos_pitch] * dz)
        scale = camera[:focal] / depth
        [camera[:center_x] + lateral * scale,
         camera[:center_y] - camera[:focal] * vertical / depth,
         scale]
      end

      def ground_sort_z(x, y, bias = 0.0, elevation = 0.0)
        projected = project_point(x, y, elevation)
        projected ? projected[1] + bias.to_f : nil
      end

      def model_view_pitch(screen_x, screen_y)
        # H-Mode7 billboards rotate with the global camera heading but never
        # tilt with screen position. A mesh uses the same global pitch; its
        # distance from the camera is handled later by perspective scaling.
        effective_pitch_degrees
      end

      def player_view_heading_degrees
        camera = camera_values
        Math.atan2(camera[:sin_yaw], camera[:cos_yaw]) * 180.0 / Math::PI
      end

      def model_view_direction(_world_x = nil, _world_y = nil, _map = nil)
        # Use one global camera heading plus the authored-front correction.
        # Map translation never rotates individual models, while a real yaw
        # change updates every bake consistently.
        camera = camera_values
        radians = Math.atan2(camera[:sin_yaw], camera[:cos_yaw]) +
                  (MODEL_CAMERA_AZIMUTH_DEGREES rescue 0.0).to_f * Math::PI / 180.0
        [Math.sin(radians), Math.cos(radians)]
      end

      def capture_sprite(sprite)
        base = sprite.instance_variable_get(:@maker_p3d_projection_base)
        unless base
          base = Array.new(7)
          sprite.instance_variable_set(:@maker_p3d_projection_base, base)
        end
        base[0] = sprite.x
        base[1] = sprite.y
        base[2] = sprite.zoom_x
        base[3] = sprite.zoom_y
        base[4] = sprite.z
        base[5] = sprite.visible
        tone = sprite.tone
        base[6] = tone ? Tone.new(tone.red, tone.green, tone.blue, tone.gray) : nil
        sprite.instance_variable_set(:@maker_p3d_projected, true)
        base
      end

      def restore_sprite(sprite)
        return unless sprite && !sprite.disposed?
        return unless sprite.instance_variable_get(:@maker_p3d_projected)
        base = sprite.instance_variable_get(:@maker_p3d_projection_base)
        return unless base
        sprite.x = base[0]
        sprite.y = base[1]
        sprite.zoom_x = base[2]
        sprite.zoom_y = base[3]
        sprite.z = base[4]
        sprite.visible = base[5]
        sprite.tone = base[6] if base[6]
        sprite.instance_variable_set(:@maker_p3d_projected, false)
      end

      def lighting_enabled?
        MapSettings.value(:PSEUDO3D_LIGHTING_ENABLED)
      end

      def cloud_height_direction
        degrees = MapSettings.value(:PSEUDO3D_SHADOW_ANGLE_DEGREES).to_f
        slope = MapSettings.value(:PSEUDO3D_CLOUD_HEIGHT_PARALLAX).to_f
        if @cloud_direction && @cloud_degrees == degrees && @cloud_slope == slope
          return @cloud_direction
        end
        @cloud_degrees, @cloud_slope = degrees, slope
        angle = degrees * Math::PI / 180.0
        @cloud_direction = [-Math.cos(angle) * slope, -Math.sin(angle) * slope].freeze
      end

      def lighting_tone(tone = nil)
        return tone unless lighting_enabled?
        ambient = MapSettings.value(:PSEUDO3D_AMBIENT_TONE).to_f
        red = tone ? tone.red.to_f : 0.0
        green = tone ? tone.green.to_f : 0.0
        blue = tone ? tone.blue.to_f : 0.0
        gray = tone ? tone.gray.to_f : 0.0
        Tone.new([[red + ambient, -255].max, 255].min.round,
                 [[green + ambient, -255].max, 255].min.round,
                 [[blue + ambient, -255].max, 255].min.round, gray.round)
      end

      def apply_lighting_tone(sprite)
        return unless lighting_enabled? && sprite && !sprite.disposed?
        sprite.tone = lighting_tone(sprite.tone)
      end

      def update_object_fog_layers(layers)
        records = {}
        layers.each do |layer|
          source = layer[:sprite]
          map = layer[:map]
          next unless map && source && source.bitmap && !source.bitmap.disposed?
          current = records[map.map_id]
          # The stock tileset fog is the authoritative cloud layer in this
          # project. Prefer it when a Maker Studio layer also exists.
          if !current || layer[:native_fog]
            records[map.map_id] = layer
          end
        end
        @object_fog_layers = records
      end

      # Whether any surface-position bake has a consumer: the object fog
      # shader path plus at least one live fog layer (optionally scoped to one
      # map). Position bakes cost a second Model3D render per model bake, so
      # they are skipped without one.
      def object_fog_available?(map_id = nil)
        return true if terrain_occlusion?
        return false unless enabled? && lighting_enabled?
        layers = @object_fog_layers
        return false unless layers && !layers.empty?
        map_id.nil? || layers.key?(map_id.to_i)
      end

      # Reuse the completed height atlas. No per-event terrain draw, rebake or
      # bitmap readback: receivers test the same surface ray as the terrain.
      def terrain_occlusion?
        state = @occlusion_state
        return false unless enabled? && state && state[:max_terrain_height].to_f > 0
        texture = state[:terrain_data_texture]
        atlas = state[:terrain_render_atlas]
        origin = state[:terrain_render_origin]
        # Cache invalidation can leave the old texture alive after its origin
        # is cleared. Only publish a complete, matching colour/height pair.
        # An in-progress replacement may still use the last completed pair.
        texture && !texture.disposed? && atlas && !atlas.disposed? &&
          origin && state[:terrain_bounds] && state[:signature] &&
          state[:terrain_data_key] && state[:terrain_data_atlas_key] &&
          state[:terrain_data_origin] == origin &&
          state[:terrain_data_atlas_key] == state[:terrain_render_atlas_key]
      end

      def configure_terrain_occlusion(shader, sprite = nil)
        active = terrain_occlusion?
        if active && sprite
          # Invisible/offscreen receivers need no fragment query or texture bind.
          width = sprite.src_rect.width * sprite.zoom_x.abs
          height = sprite.src_rect.height * sprite.zoom_y.abs
          left = sprite.x - sprite.ox * sprite.zoom_x
          top = sprite.y - sprite.oy * sprite.zoom_y
          active = sprite.visible && left < Graphics.width && left+width > 0 &&
                   top < Graphics.height && top+height > 0
          bounds = @occlusion_state[:occlusion_screen_bounds]
          active &&= !bounds || (left < bounds[2] && left+width > bounds[0] &&
                                top < bounds[3] && top+height > bounds[1])
        end
        active = !!active
        previous = shader.instance_variable_get(:@p3d_occlusion_active)
        shader.set_float('occlusionEnabled', active ? 1.0 : 0.0) if active != previous
        shader.instance_variable_set(:@p3d_occlusion_active, active)
        return unless active
        if sprite
          original = sprite.instance_variable_get(:@maker_p3d_projection_base)
          scale = original ? original[3].to_f.abs : 1.0
          shader.set_float('occlusionObjectDepth', camera_values[:focal] * scale /
                           [sprite.zoom_y.abs, 0.0001].max)
        end
        state = @occlusion_state
        texture = state[:terrain_data_texture]
        unless shader.instance_variable_get(:@p3d_occlusion_texture).equal?(texture)
          shader.set_bitmap('occlusionData', texture)
          shader.set_vec2('occlusionOrigin', *state[:terrain_render_origin])
          shader.set_vec2('occlusionSize', texture.width.to_f, texture.height.to_f)
          shader.set_vec4('occlusionBounds', *state[:terrain_bounds])
          shader.set_float('occlusionHeight', state[:max_terrain_height])
          shader.instance_variable_set(:@p3d_occlusion_texture, texture)
        end
      end

      def clear_object_fog(sprite)
        return unless sprite && !sprite.disposed?
        shader = sprite.instance_variable_get(:@maker_p3d_object_fog_shader)
        return unless shader
        previous = sprite.instance_variable_get(:@maker_p3d_object_fog_previous_shader)
        if sprite.respond_to?(:shader) && sprite.respond_to?(:shader=) &&
           sprite.shader.equal?(shader)
          sprite.shader = previous
        end
        shader.dispose if shader_alive?(shader)
        sprite.instance_variable_set(:@maker_p3d_object_fog_shader, nil)
        sprite.instance_variable_set(:@maker_p3d_object_fog_previous_shader, nil)
      rescue => error
        Console.echo_error("Pseudo3D object fog clear: #{error.message}") if defined?(Console)
      end

      def apply_object_fog(sprite, map_id, local_x, local_y,
                           world_width = TILE_SIZE, world_depth = TILE_SIZE,
                           texture_rect = nil, pixel_mapping = nil,
                           surface_mapping = nil)
        layer = @object_fog_layers && @object_fog_layers[map_id.to_i]
        source = layer && layer[:sprite]
        has_fog = enabled? && lighting_enabled? && layer && source &&
                  source.bitmap && !source.bitmap.disposed? && source.opacity.to_i > 0
        has_effect = defined?(VisualEffects) && sprite && VisualEffects.object_needed?(sprite)
        unless has_fog || has_effect
          clear_object_fog(sprite)
          return
        end
        return unless sprite && !sprite.disposed? && sprite.bitmap &&
                      sprite.respond_to?(:shader) && sprite.respond_to?(:shader=)
        shader = sprite.instance_variable_get(:@maker_p3d_object_fog_shader)
        unless shader_alive?(shader)
          current = sprite.shader
          # Do not replace a shader owned by another plugin. mkxp-z-ext draws
          # multiple Sprite shaders as separate passes rather than a chain.
          return if current
          shader = create_shader(OBJECT_FOG_SHADER_PATH, "object fog")
          return unless shader
          sprite.instance_variable_set(:@maker_p3d_object_fog_previous_shader, current)
          sprite.instance_variable_set(:@maker_p3d_object_fog_shader, shader)
          sprite.shader = shader
        end
        standing_plane = surface_mapping && surface_mapping[:standing_plane]
        shader.set_float('useStandingPlane', standing_plane ? 1.0 : 0.0)
        unless has_fog
          shader.set_float('fogOpacity', 0.0)
          shader.set_float('useModelPosition', 0.0)
          VisualEffects.configure_object(sprite, shader, map_id, local_x, local_y,
                                         texture_rect, surface_mapping) if defined?(VisualEffects)
          return
        end
        map = layer[:map]
        map_display_x = map.display_x.to_f / Game_Map::X_SUBPIXELS
        map_display_y = map.display_y.to_f / Game_Map::Y_SUBPIXELS
        parallax = layer[:follow] ? 0.0 : layer[:parallax].to_f
        offset_x = -map_display_x * (1.0 - parallax) + layer[:scroll_x].to_f
        offset_y = -map_display_y * (1.0 - parallax) + layer[:scroll_y].to_f
        texture_width = source.bitmap.width * [source.zoom_x.to_f, 0.1].max
        texture_height = source.bitmap.height * [source.zoom_y.to_f, 0.1].max
        if standing_plane
          # Standing quads reconstruct world positions from screen rays. Their
          # shader never reads the billboard UV mapping or a model height bake.
          # Keep animated clouds/lights, but skip those unused per-tile inputs.
          shader.set_bitmap('fogTexture', source.bitmap)
          shader.set_vec2('fogWorldOffset', offset_x, offset_y)
          shader.set_vec2('fogWorldOrigin', layer[:origin_x].to_f, layer[:origin_y].to_f)
          shader.set_vec2('fogTextureWorldSize', texture_width, texture_height)
          shader.set_vec2('cloudHeightDirection', *cloud_height_direction)
          shader.set_float('fogOpacity', source.opacity.to_f / 255.0)
          shader.set_float('softenEdges', MapSettings.value(:PSEUDO3D_OBJECT_FOG_SOFTEN_EDGES) ? 1.0 : 0.0)
          shader.set_float('useModelPosition', 0.0)
          VisualEffects.configure_object(sprite, shader, map_id, local_x, local_y,
                                         texture_rect, surface_mapping)
          return
        end
        rect = texture_rect
        unless rect && rect.length >= 4 && rect[2].to_f > 0 && rect[3].to_f > 0
          source_rect = sprite.src_rect
          rect = if source_rect && source_rect.width.to_f > 0 &&
                    source_rect.height.to_f > 0
                   [source_rect.x, source_rect.y,
                    source_rect.width, source_rect.height]
                 else
                   [0, 0, sprite.bitmap.width, sprite.bitmap.height]
                 end
        end
        shader.set_bitmap("fogTexture", source.bitmap)
        shader.set_vec2("fogWorldOffset", offset_x, offset_y)
        shader.set_vec2("fogWorldOrigin",
                        layer[:origin_x].to_f, layer[:origin_y].to_f)
        shader.set_vec2("fogTextureWorldSize", texture_width, texture_height)
        shader.set_vec2("cloudHeightDirection", *cloud_height_direction)
        shader.set_vec2("fogUVCenter",
                        (local_x.to_f + offset_x) / texture_width,
                        (local_y.to_f + offset_y) / texture_height)
        if pixel_mapping && pixel_mapping[:pixel_anchor]
          pixel_anchor = pixel_mapping[:pixel_anchor]
          world_per_pixel_x = pixel_mapping[:world_per_pixel_x]
          world_per_pixel_y = pixel_mapping[:world_per_pixel_y]
        else
          pixel_anchor = [rect[0].to_f + rect[2].to_f * 0.5,
                          rect[1].to_f + rect[3].to_f * 0.5]
          world_per_pixel_x = [[world_width.to_f, 1.0].max / rect[2].to_f, 0.0]
          world_per_pixel_y = [0.0,
                               [world_depth.to_f, 1.0].max / rect[3].to_f]
        end
        shader.set_vec2("objectPixelAnchor", *pixel_anchor)
        shader.set_vec2("fogUVPerPixelX",
                        world_per_pixel_x[0].to_f / texture_width,
                        world_per_pixel_x[1].to_f / texture_height)
        shader.set_vec2("fogUVPerPixelY",
                        world_per_pixel_y[0].to_f / texture_width,
                        world_per_pixel_y[1].to_f / texture_height)
        position_bitmap = surface_mapping && surface_mapping[:position_bitmap]
        if position_bitmap && !position_bitmap.disposed?
          shader.set_bitmap("modelPositionTexture", position_bitmap)
          shader.set_float("useModelPosition", 1.0)
          shader.set_vec2("modelPositionSize", position_bitmap.width.to_f,
                          position_bitmap.height.to_f)
          # Same factory-global camera as ground fog. The displayed quad,
          # rather than the original mesh XZ, determines the contact position.
          configure_world_shader(shader, camera_values,
                                 $game_map.display_x.to_f / Game_Map::X_SUBPIXELS,
                                 $game_map.display_y.to_f / Game_Map::Y_SUBPIXELS)
          shader.set_float("modelHeightMin", surface_mapping[:height_min].to_f)
          shader.set_float("modelHeightSpan", surface_mapping[:height_span].to_f)
          shader.set_vec2("cloudHeightDirection", *cloud_height_direction)
        else
          shader.set_bitmap("modelPositionTexture", nil)
          shader.set_float("useModelPosition", 0.0)
        end
        shader.set_float("fogOpacity", source.opacity.to_f / 255.0)
        soften = MapSettings.value(:PSEUDO3D_OBJECT_FOG_SOFTEN_EDGES) ? 1.0 : 0.0
        shader.set_float("softenEdges", soften)
        VisualEffects.configure_object(sprite, shader, map_id, local_x, local_y,
                                       rect, surface_mapping) if defined?(VisualEffects)
      rescue => error
        Console.echo_error("Pseudo3D object fog: #{error.message}") if defined?(Console)
        clear_object_fog(sprite)
      end

      # Build an affine screen-pixel -> map-world mapping at an OBJ's ground
      # anchor. Native model bitmaps are cropped screen render targets, so
      # fitting the fog texture to their bounding box enlarges cloud shapes on
      # tall models. Inverting two projected one-world-pixel basis vectors
      # keeps the fog scale equal to the terrain projection instead.
      def object_fog_screen_mapping(local_x, local_y, elevation, sprite,
                                    source_rect = nil, corners = nil)
        return nil unless sprite && !sprite.disposed?
        center = project_point(local_x, local_y, elevation)
        axis_x = project_point(local_x.to_f + 1.0, local_y, elevation)
        axis_y = project_point(local_x, local_y.to_f + 1.0, elevation)
        return nil unless center && axis_x && axis_y
        a = axis_x[0] - center[0]
        b = axis_y[0] - center[0]
        c = axis_x[1] - center[1]
        d = axis_y[1] - center[1]
        determinant = a * d - b * c
        return nil if determinant.abs < 0.000001
        inverse = 1.0 / determinant
        pixel_anchor = [center[0] - sprite.x.to_f,
                        center[1] - sprite.y.to_f]
        pixel_scale_x = 1.0
        pixel_scale_y = 1.0
        if source_rect && corners && source_rect.width.to_f > 0.0 &&
           source_rect.height.to_f > 0.0 && corners.length >= 6
          screen_width = corners[2].to_f - corners[0].to_f
          screen_height = corners[5].to_f - corners[1].to_f
          return nil if screen_width.abs < 0.000001 || screen_height.abs < 0.000001
          pixel_scale_x = screen_width / source_rect.width.to_f
          pixel_scale_y = screen_height / source_rect.height.to_f
          pixel_anchor = [source_rect.x.to_f +
                          (center[0] - corners[0].to_f) / pixel_scale_x,
                          source_rect.y.to_f +
                          (center[1] - corners[1].to_f) / pixel_scale_y]
        end
        {
          :pixel_anchor => pixel_anchor,
          :world_per_pixel_x => [d * inverse * pixel_scale_x,
                                 -c * inverse * pixel_scale_x],
          :world_per_pixel_y => [-b * inverse * pixel_scale_y,
                                 a * inverse * pixel_scale_y]
        }
      end

      def apply_standing_sprite(sprite, sort_y = nil, sort_bias = 0.0, elevation = 0.0)
        return unless enabled? && sprite && !sprite.disposed? && sprite.bitmap
        base = capture_sprite(sprite)
        return unless base[5]
        base_x = base[0]
        base_y = base[1]
        base_zoom_x = base[2]
        base_zoom_y = base[3]
        base_z = base[4]
        width = sprite.src_rect&.width.to_f
        height = sprite.src_rect&.height.to_f
        width = sprite.bitmap.width.to_f if width <= 0
        height = sprite.bitmap.height.to_f if height <= 0
        width = 1.0 if width < 1.0
        height = 1.0 if height < 1.0
        source_anchor = sprite.instance_variable_get(:@maker_p3d_source_anchor)
        source_anchor_x = source_anchor ? source_anchor[0].to_f : width / 2.0
        source_anchor_y = source_anchor ? source_anchor[1].to_f : height
        anchor_x = base_x + (source_anchor_x - sprite.ox.to_f) * base_zoom_x
        anchor_y = base_y + (source_anchor_y - sprite.oy.to_f) * base_zoom_y.abs
        camera = camera_values
        dx = anchor_x - camera[:center_x]
        dy = anchor_y - (camera[:center_y] + camera[:back])
        lateral = camera[:cos_yaw] * dx - camera[:sin_yaw] * dy
        forward = camera[:sin_yaw] * dx + camera[:cos_yaw] * dy
        dz = elevation.to_f - camera[:height]
        depth = (-camera[:cos_pitch] * forward) - (camera[:sin_pitch] * dz)
        if depth <= 0.001
          sprite.visible = false
          return
        end
        vertical = (-camera[:sin_pitch] * forward) + (camera[:cos_pitch] * dz)
        scale = camera[:focal] / depth
        projected_x = camera[:center_x] + lateral * scale
        projected_y = camera[:center_y] - camera[:focal] * vertical / depth
        sprite.zoom_x = base_zoom_x * scale
        sprite.zoom_y = base_zoom_y * scale
        sprite.x = projected_x - (source_anchor_x - sprite.ox.to_f) * sprite.zoom_x
        sprite.y = projected_y - (source_anchor_y - sprite.oy.to_f) * sprite.zoom_y.abs
        if base_z.to_f < 900
          if sort_y
            sort_z = ground_sort_z(anchor_x, sort_y, sort_bias, elevation)
            sprite.z = sort_z if sort_z
          else
            # TileSprite#z is a layer/order value, not a world-space Y
            # coordinate. Subtracting the sprite's screen anchor here pushed
            # many overhead tiles behind the projected ground. Keep the
            # projected foot as the primary sort key and retain the native
            # layer as a tiny tie-breaker.
            sprite.z = projected_y.round + base_z.to_f * 0.001
          end
        end
      end

      def standing_tile?(sprite)
        band = sprite.respond_to?(:cell_band) ? sprite.cell_band : nil
        return band.to_f > 0 if band
        priority = sprite.respond_to?(:priority) ? sprite.priority.to_i : 0
        priority > 0 && sprite.z.to_f > 2
      end

      def each_native_tile(renderer)
        (renderer.instance_variable_get(:@tiles) || []).each do |column|
          column.each do |cell|
            cell.each { |sprite| yield sprite if sprite }
          end
        end
      end

      def each_extended_tile(renderer)
        (renderer.instance_variable_get(:@ext_pool) || []).each do |column|
          next unless column
          column.each do |cell|
            next unless cell
            cell.each { |sprite| yield sprite if sprite }
          end
        end
      end

      def create_shader(path, label)
        return nil unless defined?(Shader) && File.exist?(path)
        return nil unless Sprite.instance_methods.include?(:shader=)
        Shader.new(path).extend(ShaderParameters)
      rescue => error
        Console.echo_error(
          "Pseudo3D #{label} shader: #{error.message}"
        ) if defined?(Console)
        nil
      end

      def create_ground_shader
        create_shader(GROUND_SHADER_PATH, "ground")
      end

      def create_terrain_shader
        create_shader(TERRAIN_SHADER_PATH, "terrain")
      end

      def create_fog_shader
        create_shader(FOG_SHADER_PATH, "fog")
      end

      def create_object_fog_shader
        create_shader(OBJECT_FOG_SHADER_PATH, "object fog")
      end

      def create_shadow_shader
        create_shader(SHADOW_SHADER_PATH, "shadow")
      end

      def ground_shader_active?(state)
        shader = state && state[:ground_shader]
        shader && (!shader.respond_to?(:disposed?) || !shader.disposed?)
      end

      def ensure_state(renderer)
        state = renderer.instance_variable_get(:@maker_p3d_mode7)
        if state && state[:target] && !state[:target].disposed?
          resize_screen_targets(state)
          return state
        end
        dispose_state(renderer)
        target = Bitmap.new(Graphics.width, Graphics.height)
        sprite = Sprite.new(renderer.viewport)
        sprite.bitmap = target
        sprite.z = -90
        sprite.visible = false
        ground_shader = create_ground_shader
        terrain_shader = create_terrain_shader
        foreground_shader = create_terrain_shader
        overpass_shader = create_terrain_shader
        sprite.shader = ground_shader if ground_shader
        terrain_sprite = Sprite.new(renderer.viewport)
        terrain_sprite.shader = terrain_shader if terrain_shader
        terrain_sprite.z = -80
        terrain_sprite.visible = false
        overpass_target = Bitmap.new(Graphics.width, Graphics.height)
        overpass_sprite = Sprite.new(renderer.viewport)
        overpass_sprite.bitmap = overpass_target
        overpass_sprite.shader = overpass_shader if overpass_shader
        overpass_sprite.z = OVERPASS_LAYER_Z
        overpass_sprite.visible = false
        foreground_target = Bitmap.new(Graphics.width, Graphics.height)
        foreground_sprite = Sprite.new(renderer.viewport)
        foreground_sprite.bitmap = foreground_target
        foreground_sprite.shader = foreground_shader if foreground_shader
        foreground_sprite.visible = false
        state = {
          target: target,
          sprite: sprite,
          overpass_target: overpass_target,
          overpass_sprite: overpass_sprite,
          foreground_target: foreground_target,
          foreground_sprite: foreground_sprite,
          terrain_sprite: terrain_sprite,
          ground_shader: ground_shader,
          terrain_shader: terrain_shader,
          foreground_shader: foreground_shader,
          overpass_shader: overpass_shader,
          ground_atlas: nil,
          ground_atlas_key: nil,
          ground_atlas_origin: nil,
          ground_atlas_pending: nil,
          ground_atlas_chunks: nil,
          ground_atlas_animation_dirty: false,
          ground_atlas_animation_cursor: 0,
          chunks: {},
          clock: 0,
          signature: nil,
          animation_signature: nil,
          render_key: nil,
          terrain_atlas: nil,
          terrain_atlas_key: nil,
          terrain_data: nil,
          terrain_data_key: nil,
          terrain_data_origin: nil,
          terrain_data_atlas_key: nil,
          terrain_data_pending: nil,
          terrain_data_texture: nil,
          terrain_data_bytes: nil,
          terrain_render_atlas: nil,
          terrain_render_origin: nil,
          terrain_render_atlas_key: nil,
          terrain_retired_resources: [],
          terrain_entries_cache: {},
          terrain_entries_cache_clock: 0,
          terrain_cells: nil,
          terrain_cells_key: nil,
          terrain_cells_texture: nil,
          terrain_cells_origin: nil,
          shadow_data: nil,
          shadow_data_key: nil,
          shadow_data_texture: nil,
          fog_overlays: {},
          shadow_overlays: {},
          character_shadow_cache: {},
          model_shadow_records: nil,
          model_shadow_records_key: nil,
          shadow_texture: nil,
          dest_rect: Rect.new(0, 0, 1, 1),
          source_rect: Rect.new(0, 0, 1, 1)
        }
        renderer.instance_variable_set(:@maker_p3d_mode7, state)
        state
      end

      # Screen buffers are disposable; map chunks, terrain, shaders and standing
      # records belong to the world and must survive a menu canvas change.
      def resize_screen_targets(state)
        return if state[:target].width == Graphics.width && state[:target].height == Graphics.height
        replacements = {}
        begin
          [:target, :overpass_target, :foreground_target].each do |key|
            replacements[key] = Bitmap.new(Graphics.width, Graphics.height)
          end
        rescue Exception
          replacements.each_value(&:dispose)
          raise
        end
        replacements.each do |key, bitmap|
          sprite_key = key == :target ? :sprite : key.to_s.sub('target', 'sprite').to_sym
          sprite, old = state[sprite_key], state[key]
          sprite.bitmap = bitmap if sprite && sprite.bitmap.equal?(old)
          state[key] = bitmap
          old.dispose if old && !old.disposed?
        end
        state[:render_key] = nil
        state[:rendered_view_valid] = false
      end

      def clear_chunks(state)
        @occlusion_state = nil if @occlusion_state.equal?(state)
        state[:rendered_view] = nil
        (state[:chunks] || {}).each_value do |entry|
          bitmap = entry[:bitmap]
          bitmap.dispose if bitmap && !bitmap.disposed?
        end
        state[:chunks] = {}
        state[:render_key] = nil
        state[:ground_atlas_key] = nil
        state[:ground_atlas_chunks] = nil
        state[:ground_atlas_animation_dirty] = false
        state[:ground_atlas_animation_cursor] = 0
        state[:terrain_data_key] = nil
        state[:terrain_data_bytes] = nil
        state[:terrain_data_origin] = nil
        state[:terrain_data_atlas_key] = nil
        terrain_pending = state[:terrain_data_pending]
        if terrain_pending && terrain_pending[:texture] &&
           !terrain_pending[:texture].disposed?
          terrain_pending[:texture].dispose
        end
        state[:terrain_data_pending] = nil
        render_atlas = state[:terrain_render_atlas]
        ground_atlas = state[:ground_atlas]
        if render_atlas && render_atlas != ground_atlas && !render_atlas.disposed?
          render_atlas.dispose
        end
        (state[:terrain_retired_resources] || []).each do |resource|
          resource.dispose if resource && !resource.disposed?
        end
        state[:terrain_render_atlas] = nil
        state[:terrain_render_origin] = nil
        state[:terrain_render_atlas_key] = nil
        state[:terrain_retired_resources] = []
        state[:terrain_entries_cache] = {}
        state[:terrain_entries_cache_clock] = 0
        state[:character_shadow_cache] = {}
        state[:model_shadow_records] = nil
        state[:model_shadow_records_key] = nil
        pending = state[:ground_atlas_pending]
        pending[:bitmap].dispose if pending && pending[:bitmap] && !pending[:bitmap].disposed?
        state[:ground_atlas_pending] = nil
      end

      def dispose_state(renderer)
        state = renderer.instance_variable_get(:@maker_p3d_mode7)
        return unless state
        state[:standing_tiles].dispose if state[:standing_tiles]
        @occlusion_state = nil if @occlusion_state.equal?(state)
        clear_chunks(state)
        atlas = state[:terrain_atlas]
        atlas.dispose if atlas && !atlas.disposed?
        shadow_texture = state[:shadow_texture]
        shadow_texture.dispose if shadow_texture && !shadow_texture.disposed?
        ground_atlas = state[:ground_atlas]
        ground_atlas.dispose if ground_atlas && !ground_atlas.disposed?
        state[:sprite]&.dispose unless state[:sprite]&.disposed?
        ground_shader = state[:ground_shader]
        ground_shader.dispose if ground_shader && !ground_shader.disposed?
        [:terrain_shader, :foreground_shader, :overpass_shader].each do |key|
          shader = state[key]
          shader.dispose if shader && !shader.disposed?
        end
        [:terrain_data_texture, :terrain_cells_texture, :shadow_data_texture].each do |key|
          bitmap = state[key]
          bitmap.dispose if bitmap && !bitmap.disposed?
        end
        (state[:fog_overlays] || {}).each_value do |entry|
          entry[:sprite].dispose if entry[:sprite] && !entry[:sprite].disposed?
          entry[:shader].dispose if entry[:shader] && !entry[:shader].disposed?
        end
        (state[:shadow_overlays] || {}).each_value do |entry|
          entry[:sprite].dispose if entry[:sprite] && !entry[:sprite].disposed?
          entry[:shader].dispose if entry[:shader] && !entry[:shader].disposed?
        end
        state[:target]&.dispose unless state[:target]&.disposed?
        state[:terrain_sprite]&.dispose unless state[:terrain_sprite]&.disposed?
        state[:overpass_sprite]&.dispose unless state[:overpass_sprite]&.disposed?
        state[:overpass_target]&.dispose unless state[:overpass_target]&.disposed?
        state[:foreground_sprite]&.dispose unless state[:foreground_sprite]&.disposed?
        state[:foreground_target]&.dispose unless state[:foreground_target]&.disposed?
        renderer.instance_variable_set(:@maker_p3d_mode7, nil)
      end

      def restore_tilemap(renderer, restore_native = true)
        if restore_native
          unless defined?(StandingTiles)
            each_native_tile(renderer) { |sprite| restore_sprite(sprite) }
            each_extended_tile(renderer) { |sprite| restore_sprite(sprite) }
          end
          hidden = renderer.instance_variable_get(:@maker_p3d_hidden) || []
          hidden.each do |sprite|
            sprite.visible = true if sprite && !sprite.disposed? && sprite.bitmap
          end
          renderer.instance_variable_set(:@maker_p3d_hidden, [])
        end
        state = renderer.instance_variable_get(:@maker_p3d_mode7)
        state[:sprite].visible = false if state && state[:sprite] && !state[:sprite].disposed?
        if state && state[:overpass_sprite] && !state[:overpass_sprite].disposed?
          state[:overpass_sprite].visible = false
        end
        if state && state[:foreground_sprite] && !state[:foreground_sprite].disposed?
          state[:foreground_sprite].visible = false
        end
        if state && state[:terrain_sprite] && !state[:terrain_sprite].disposed?
          state[:terrain_sprite].visible = false
        end
        (state && state[:fog_overlays] || {}).each_value do |entry|
          entry[:sprite].visible = false if entry[:sprite] && !entry[:sprite].disposed?
        end
        (state && state[:shadow_overlays] || {}).each_value do |entry|
          entry[:sprite].visible = false if entry[:sprite] && !entry[:sprite].disposed?
        end
      end

      def map_origin_pixels(map, current_map)
        dx = (current_map.display_x.to_f - map.display_x.to_f) / Game_Map::X_SUBPIXELS
        dy = (current_map.display_y.to_f - map.display_y.to_f) / Game_Map::Y_SUBPIXELS
        [(dx / TILE_SIZE).round * TILE_SIZE, (dy / TILE_SIZE).round * TILE_SIZE]
      end

      def scene_maps
        maps = if $map_factory && $map_factory.respond_to?(:maps)
                 $map_factory.maps.select { |map| map&.instance_variable_get(:@map) }
               else
                 [$game_map].compact
               end
        maps.sort_by { |map| map.equal?($game_map) ? 1 : 0 }.map do |map|
          origin = map_origin_pixels(map, $game_map)
          [map, origin[0], origin[1]]
        end
      end

      def scene_signature(records)
        records.map do |map, origin_x, origin_y|
          ext = defined?(MakerStudio) ? MakerStudio.get_extended_data_for(map.map_id) : nil
          # Origin is camera-relative and changes on every map scroll. It is
          # placement state, not scene resource identity; including it here
          # flushed every chunk/atlas whenever the player moved one tile.
          [map.map_id, map.width, map.height,
           map.data.object_id, ext&.object_id, map.tileset_name, map.autotile_names]
        end
      end

      def terrain_signature(records)
        return nil unless defined?(MakerStudio) && MakerStudio.respond_to?(:terrain_revision)
        records.map do |map, _origin_x, _origin_y|
          [map.map_id, MakerStudio.terrain_revision(map.map_id)]
        end
      end

      def animation_signature(renderer)
        autotiles = renderer.instance_variable_get(:@autotiles)
        frames = autotiles&.instance_variable_get(:@current_frames) || {}
        frames.keys.sort.map { |key| [key, frames[key]] }
      end

      def reset_tile_sprite(sprite)
        sprite.bitmap = nil
        sprite.src_rect.set(0, 0, 0, 0)
        sprite.opacity = 255
        sprite.angle = 0
        sprite.mirror = false
        sprite.zoom_x = 1.0
        sprite.zoom_y = 1.0
        sprite.ox = 0
        sprite.oy = 0
      end

      def blit_configured_tile(target, x, y, sprite, opacity = 255)
        return false unless sprite.bitmap && !sprite.bitmap.disposed?
        rect = sprite.src_rect
        if rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 ||
           rect.x + rect.width > sprite.bitmap.width || rect.y + rect.height > sprite.bitmap.height
          rect = Rect.new(0, 0, [TILE_SIZE, sprite.bitmap.width].min,
                          [TILE_SIZE, sprite.bitmap.height].min)
        end
        alpha = (sprite.opacity.to_i * opacity.to_i / 255.0).round
        target.blt(x, y, sprite.bitmap, rect, alpha)
        sprite.animated
      end

      def draw_ground_cell(renderer, bitmap, map, tile_x, tile_y, dest_x, dest_y, sprite)
        animated = false
        index = tile_y * map.width + tile_x
        cap = defined?(MakerStudio) ? MakerStudio.cell_ground_cap(map, tile_x, tile_y) : -1
        3.times do |layer|
          tile_id = map.data[tile_x, tile_y, layer].to_i
          entry = defined?(MakerStudio) ? MakerStudio.native_props_at(map.map_id, map.width, layer, index) : nil
          props = entry ? entry[0] : nil
          special = props && (props["autotile_name"] || props["tileset_id"])
          next if tile_id < TilemapRenderer::TILES_PER_AUTOTILE && !special
          priority = if defined?(MakerStudio)
                       MakerStudio.resolve_band_priority(map, tile_id, props)
                     else
                       map.priorities[tile_id].to_i
                     end
          next if defined?(StandingTiles) ? StandingTiles.standing?(priority, props) : priority >= 1 && layer > cap
          reset_tile_sprite(sprite)
          renderer.refresh_tile_bitmap(sprite, map, tile_id)
          renderer.bind_native_prop_tile(sprite, props, entry && entry[1], map, tile_id) if props
          animated ||= blit_configured_tile(bitmap, dest_x, dest_y, sprite)
        end
        if defined?(MakerStudio)
          MakerStudio.ext_layers_index_for(map.map_id, map.width).each do |layer|
            props = layer[:tiles][index]
            next unless props
            tile_id = props["tile_id"].to_i
            next if tile_id <= 0 && !props["autotile_name"]
            priority = MakerStudio.resolve_band_priority(map, tile_id, props)
            next if defined?(StandingTiles) ? StandingTiles.standing?(priority, props) : priority >= 1 && MakerStudio.unified_layer(layer["id"]) > cap
            reset_tile_sprite(sprite)
            renderer.setup_extended_sprite_bitmap(sprite, tile_id, map, props)
            if sprite.bitmap
              MakerStudio::TileEffects.apply_to_sprite(
                sprite, props, renderer.instance_variable_get(:@tilesets),
                renderer.instance_variable_get(:@autotiles)
              )
              animated ||= blit_configured_tile(bitmap, dest_x, dest_y, sprite, layer["opacity"])
            end
          end
        end
        animated
      end

      def build_chunk(renderer, state, chunk_x, chunk_y)
        world_left = chunk_x * CHUNK_SIZE
        world_top = chunk_y * CHUNK_SIZE
        world_right = world_left + CHUNK_SIZE
        world_bottom = world_top + CHUNK_SIZE
        intersections = state[:records].select do |map, origin_x, origin_y|
          origin_x < world_right && origin_y < world_bottom &&
            origin_x + map.width * TILE_SIZE > world_left &&
            origin_y + map.height * TILE_SIZE > world_top
        end
        return { bitmap: nil, animated: false, used: state[:clock] } if intersections.empty?

        bitmap = Bitmap.new(CHUNK_SIZE, CHUNK_SIZE)
        tile_sprite = TilemapRenderer::TileSprite.new(renderer.viewport)
        animated = false
        drawn = false
        intersections.each do |map, origin_x, origin_y|
          start_x = [[(world_left - origin_x).div(TILE_SIZE), 0].max, map.width].min
          start_y = [[(world_top - origin_y).div(TILE_SIZE), 0].max, map.height].min
          end_x = [[(world_right - 1 - origin_x).div(TILE_SIZE), map.width - 1].min, 0].max
          end_y = [[(world_bottom - 1 - origin_y).div(TILE_SIZE), map.height - 1].min, 0].max
          next if start_x > end_x || start_y > end_y
          (start_y..end_y).each do |tile_y|
            (start_x..end_x).each do |tile_x|
              dest_x = origin_x + tile_x * TILE_SIZE - world_left
              dest_y = origin_y + tile_y * TILE_SIZE - world_top
              was_animated = draw_ground_cell(
                renderer, bitmap, map, tile_x, tile_y, dest_x, dest_y, tile_sprite
              )
              animated ||= was_animated
              drawn = true
            end
          end
        end
        tile_sprite.bitmap = nil
        tile_sprite.dispose
        unless drawn
          bitmap.dispose
          bitmap = nil
        end
        { bitmap: bitmap, animated: animated, used: state[:clock] }
      end

      def trim_chunk_cache(state)
        return if state[:chunks].length <= CHUNK_CACHE_LIMIT
        key, entry = state[:chunks].min_by { |_chunk_key, value| value[:used] }
        entry[:bitmap].dispose if entry[:bitmap] && !entry[:bitmap].disposed?
        state[:chunks].delete(key)
      end

      def chunk_for(renderer, state, chunk_x, chunk_y)
        static_key = [chunk_x, chunk_y, nil]
        animated_key = [chunk_x, chunk_y, state[:animation_signature]]
        entry = state[:chunks][static_key] || state[:chunks][animated_key]
        unless entry
          entry = build_chunk(renderer, state, chunk_x, chunk_y)
          key = entry[:animated] ? animated_key : static_key
          state[:chunks][key] = entry
          trim_chunk_cache(state)
        end
        state[:clock] += 1
        entry[:used] = state[:clock]
        entry[:bitmap]
      end

      def visible_world_bounds(camera, display_x, display_y)
        rows = camera[:rows]
        return [display_x, display_y, display_x + Graphics.width, display_y + Graphics.height] if rows.empty?
        # A row stores the signed forward/world-Y intersection and its two
        # horizontal endpoints in the yaw=0 basis.  In camera space, points in
        # front of the camera have a negative forward value (the same sign used
        # by project_point and the projection shaders).  Convert both endpoints
        # back into map space here so the atlas covers the rotated frustum.
        # The ground frustum is a trapezoid. All intermediate scanline ends
        # lie on its straight edges, so four corners have the exact same
        # extrema as hundreds of row endpoints, even after yaw rotation.
        key = [rows.object_id, camera[:center_x], camera[:center_y], camera[:back],
               camera[:sin_yaw], camera[:cos_yaw]]
        if @visible_bounds_key == key
          local = @visible_bounds_local
          return [display_x + local[0], display_y + local[1],
                  display_x + local[2], display_y + local[3]]
        end
        points = [rows.first, rows.last].flat_map do |row|
          forward = row[2].to_f - (camera[:center_y] + camera[:back])
          [row[3], row[4]].map do |world_x|
            lateral = world_x.to_f - camera[:center_x]
            [camera[:center_x] + camera[:sin_yaw] * forward + camera[:cos_yaw] * lateral,
             camera[:center_y] + camera[:back] + camera[:cos_yaw] * forward - camera[:sin_yaw] * lateral]
          end
        end
        left = points.map(&:first).min
        right = points.map(&:first).max
        top = points.map(&:last).min
        bottom = points.map(&:last).max
        margin = TILE_SIZE * 2
        @visible_bounds_key = key
        @visible_bounds_local = [left - margin, top - margin, right + margin, bottom + margin]
        [display_x + left - margin, display_y + top - margin,
         display_x + right + margin, display_y + bottom + margin]
      end

      # A raised surface intersects a screen ray closer to the camera than
      # its z=0 intersection. Include that part of the ray as well, otherwise
      # a near cliff is clipped by the atlas even while it is on screen.
      def terrain_atlas_bounds(camera, display_x, display_y, bounds)
        # terrainData encodes elevation as an unsigned byte (0..255).
        ratio = [255.0 / camera[:height], 1.0].min
        eye_x = display_x + camera[:center_x]
        eye_y = display_y + camera[:center_y] + camera[:back]
        [
          [bounds[0], bounds[0] + (eye_x - bounds[0]) * ratio].min,
          [bounds[1], bounds[1] + (eye_y - bounds[1]) * ratio].min,
          [bounds[2], bounds[2] + (eye_x - bounds[2]) * ratio].max,
          [bounds[3], bounds[3] + (eye_y - bounds[3]) * ratio].max
        ]
      end

      def atlas_key_covers?(key, signature, bounds, margin = 0)
        key && key[4] == signature &&
          key[0] * CHUNK_SIZE <= bounds[0] - margin &&
          key[1] * CHUNK_SIZE <= bounds[1] - margin &&
          (key[2] + 1) * CHUNK_SIZE >= bounds[2] + margin &&
          (key[3] + 1) * CHUNK_SIZE >= bounds[3] + margin
      end

      def prepare_ground_atlas(renderer, state, bounds)
        # Recenter with a reserve, before the old atlas reaches the viewport.
        # The smaller retain margin gives hysteresis at chunk boundaries.
        first_x = (bounds[0] - CHUNK_SIZE).floor.div(CHUNK_SIZE)
        first_y = (bounds[1] - CHUNK_SIZE).floor.div(CHUNK_SIZE)
        last_x = (bounds[2] + CHUNK_SIZE - 1).ceil.div(CHUNK_SIZE)
        last_y = (bounds[3] + CHUNK_SIZE - 1).ceil.div(CHUNK_SIZE)
        pending = state[:ground_atlas_pending]
        atlas = state[:ground_atlas]
        if pending && atlas_key_covers?(pending[:key], state[:signature], bounds)
          first_x, first_y, last_x, last_y = pending[:key]
        elsif atlas && !atlas.disposed? &&
              (state[:terrain_data_pending] ||
               atlas_key_covers?(state[:ground_atlas_key], state[:signature],
                                 bounds, CHUNK_SIZE / 2))
          first_x, first_y, last_x, last_y = state[:ground_atlas_key]
          if pending
            pending[:bitmap].dispose unless pending[:bitmap].disposed?
            state[:ground_atlas_pending] = nil
          end
        end
        width = (last_x - first_x + 1) * CHUNK_SIZE
        height = (last_y - first_y + 1) * CHUNK_SIZE
        # The colour atlas geometry is independent of the current autotile
        # frame.  Keeping animation_signature in this key allocated and
        # rebuilt a full-screen bitmap every time an autotile advanced.
        key = [first_x, first_y, last_x, last_y, state[:signature]]
        atlas = state[:ground_atlas]
        if state[:ground_atlas_key] != key || !atlas || atlas.disposed?
          pending = state[:ground_atlas_pending]
          unless pending && pending[:key] == key
            pending[:bitmap].dispose if pending && pending[:bitmap] && !pending[:bitmap].disposed?
            pending = {
              :key => key, :first_x => first_x, :first_y => first_y,
              :last_x => last_x, :last_y => last_y,
              :bitmap => Bitmap.new(width, height), :chunks => [],
              :build_chunks => [], :index => 0
            }
            old_key = state[:ground_atlas_key]
            reusable = atlas && !atlas.disposed? && old_key &&
                       old_key[4] == state[:signature]
            if reusable
              # Copy the overlap on the GPU; only newly exposed strips need
              # tile composition. No screen capture or texture readback.
              pending[:bitmap].blt((old_key[0] - first_x) * CHUNK_SIZE,
                                   (old_key[1] - first_y) * CHUNK_SIZE, atlas,
                                   Rect.new(0, 0, atlas.width, atlas.height))
            end
            (first_y..last_y).each do |chunk_y|
              (first_x..last_x).each do |chunk_x|
                chunk = [chunk_x, chunk_y]
                pending[:chunks] << chunk
                next if reusable && chunk_x.between?(old_key[0], old_key[2]) &&
                                    chunk_y.between?(old_key[1], old_key[3])
                pending[:build_chunks] << chunk
              end
            end
            state[:ground_atlas_pending] = pending
          end
          # Hidden preparation can use up to eight chunks within an 8 ms
          # budget; never turn normal map scrolling into a synchronous bake.
          preparing = transition_preparing?
          budget = preparing ? 8 : 1
          deadline = System.uptime + 0.008 if preparing
          budget.times do
            chunk_x, chunk_y = pending[:build_chunks][pending[:index]]
            break unless chunk_x
            chunk = chunk_for(renderer, state, chunk_x, chunk_y)
            if chunk && !chunk.disposed?
              pending[:bitmap].blt((chunk_x - first_x) * CHUNK_SIZE,
                                   (chunk_y - first_y) * CHUNK_SIZE, chunk,
                                   Rect.new(0, 0, CHUNK_SIZE, CHUNK_SIZE))
            end
            pending[:index] += 1
            break if preparing && System.uptime >= deadline
          end
          if pending[:index] >= pending[:build_chunks].length
            old = state[:ground_atlas]
            state[:ground_atlas] = pending[:bitmap]
            state[:ground_atlas_key] = key
            state[:ground_atlas_origin] = [first_x * CHUNK_SIZE,
                                           first_y * CHUNK_SIZE]
            state[:ground_atlas_chunks] = pending[:chunks].dup
            state[:ground_atlas_animation_dirty] = false
            state[:ground_atlas_pending] = nil
            if old && !old.disposed? && old != state[:ground_atlas]
              # The projected terrain must switch its colour atlas and height
              # texture as one pair. Keep the previous atlas alive while the
              # new terrainData is built over several update frames.
              if old == state[:terrain_render_atlas]
                state[:terrain_retired_resources] << old
              else
                old.dispose
              end
            end
            atlas = state[:ground_atlas]
          end
        end
        # Refresh only chunks containing animated tiles, in place.  Static
        # chunks and the atlas bitmap itself remain untouched between frames.
        if atlas && !atlas.disposed? && state[:ground_atlas_animation_dirty]
          origin_x, origin_y = state[:ground_atlas_origin]
          animated_chunks = (state[:ground_atlas_chunks] || []).select do |chunk_x, chunk_y|
            state[:chunks].any? do |chunk_key, entry|
              chunk_key[0] == chunk_x && chunk_key[1] == chunk_y && entry[:animated]
            end
          end
          cursor = state[:ground_atlas_animation_cursor].to_i
          chunk_x, chunk_y = animated_chunks[cursor]
          if chunk_x
            old_keys = state[:chunks].keys.select do |chunk_key|
              chunk_key[0] == chunk_x && chunk_key[1] == chunk_y &&
                state[:chunks][chunk_key][:animated]
            end
            replacement = build_chunk(renderer, state, chunk_x, chunk_y)
            old_keys.each do |old_key|
              old = state[:chunks].delete(old_key)
              old[:bitmap].dispose if old && old[:bitmap] && !old[:bitmap].disposed?
            end
            animated_key = [chunk_x, chunk_y, state[:animation_signature]]
            state[:chunks][animated_key] = replacement
            chunk = replacement[:bitmap]
            atlas.blt((chunk_x * CHUNK_SIZE) - origin_x,
                      (chunk_y * CHUNK_SIZE) - origin_y, chunk,
                      Rect.new(0, 0, CHUNK_SIZE, CHUNK_SIZE)) if chunk
            cursor += 1
          end
          if cursor >= animated_chunks.length
            state[:ground_atlas_animation_dirty] = false
            state[:ground_atlas_animation_cursor] = 0
          else
            state[:ground_atlas_animation_cursor] = cursor
          end
        end
        atlas
      end

      def render_ground_shader(renderer, state, camera, display_x, display_y, bounds)
        return false unless ground_shader_active?(state)
        atlas = prepare_ground_atlas(renderer, state,
          terrain_atlas_bounds(camera, display_x, display_y, bounds))
        return false unless atlas && !atlas.disposed?
        shader = state[:ground_shader]
        origin = state[:ground_atlas_origin]
        shader.set_vec2("screenSize", Graphics.width.to_f, Graphics.height.to_f)
        shader.set_vec2("atlasOrigin", origin[0].to_f, origin[1].to_f)
        shader.set_vec2("atlasSize", atlas.width.to_f, atlas.height.to_f)
        shader.set_vec2("displayPosition", display_x, display_y)
        shader.set_vec2("cameraCenter", camera[:center_x], camera[:center_y])
        shader.set_float("cameraBack", camera[:back])
        shader.set_float("cameraHeight", camera[:height])
        shader.set_float("cameraSinPitch", camera[:sin_pitch])
        shader.set_float("cameraCosPitch", camera[:cos_pitch])
        shader.set_float("cameraFocal", camera[:focal])
        shader.set_float("cameraSinYaw", camera[:sin_yaw])
        shader.set_float("cameraCosYaw", camera[:cos_yaw])
        shader.set_float("farDistance", far_distance)
        shader.set_float("fadeStart", far_distance * 0.86)
        sprite = state[:sprite]
        sprite.bitmap = atlas unless sprite.bitmap == atlas
        sprite.src_rect.set(0, 0, atlas.width, atlas.height)
        sprite.x = 0
        sprite.y = 0
        sprite.ox = 0
        sprite.oy = 0
        sprite.zoom_x = Graphics.width.to_f / atlas.width
        sprite.zoom_y = Graphics.height.to_f / atlas.height
        sprite.z = -90
        sprite.visible = true
        true
      rescue => error
        Console.echo_error(
          "Pseudo3D ground shader render: #{error.message}"
        ) if defined?(Console)
        shader = state[:ground_shader]
        shader.dispose if shader && !shader.disposed?
        state[:ground_shader] = nil
        state[:sprite].shader = nil if state[:sprite]&.respond_to?(:shader=)
        false
      end

      def shader_alive?(shader)
        shader && (!shader.respond_to?(:disposed?) || !shader.disposed?)
      end

      def configure_projection_shader(shader, camera, display_x, display_y,
                                      atlas, origin, terrain_data = nil)
        shader.set_vec2("screenSize", Graphics.width.to_f, Graphics.height.to_f)
        shader.set_vec2("atlasOrigin", origin[0].to_f, origin[1].to_f)
        shader.set_vec2("atlasSize", atlas.width.to_f, atlas.height.to_f)
        shader.set_vec2("displayPosition", display_x, display_y)
        shader.set_vec2("cameraCenter", camera[:center_x], camera[:center_y])
        shader.set_float("cameraBack", camera[:back])
        shader.set_float("cameraHeight", camera[:height])
        shader.set_float("cameraSinPitch", camera[:sin_pitch])
        shader.set_float("cameraCosPitch", camera[:cos_pitch])
        shader.set_float("cameraFocal", camera[:focal])
        shader.set_float("cameraSinYaw", camera[:sin_yaw])
        shader.set_float("cameraCosYaw", camera[:cos_yaw])
        shader.set_float("farDistance", far_distance)
        shader.set_float("fadeStart", far_distance * 0.86)
        shader.set_bitmap("terrainData", terrain_data) if terrain_data
      end

      def configure_fullscreen_sprite(sprite, atlas, z)
        sprite.bitmap = atlas unless sprite.bitmap == atlas
        sprite.src_rect.set(0, 0, atlas.width, atlas.height)
        sprite.x = 0
        sprite.y = 0
        sprite.ox = 0
        sprite.oy = 0
        sprite.zoom_x = Graphics.width.to_f / atlas.width
        sprite.zoom_y = Graphics.height.to_f / atlas.height
        sprite.z = z
      end

      # The GPU receives a map-aligned height field rather than an arbitrary
      # triangle buffer. Red stores elevation in pixels, green marks an
      # overpass and blue marks cells authored by Maker Studio. It is rebuilt
      # only when the visible chunk atlas or terrain revision changes.
      def prepare_terrain_data(state, atlas, entries)
        origin = state[:ground_atlas_origin]
        atlas_key = state[:ground_atlas_key]
        return nil unless origin && atlas_key && atlas && !atlas.disposed?
        # The colour atlas follows autotile animation, but this texture only
        # stores map geometry. Tying it to ground_atlas_key forced a full
        # atlas-sized Ruby pixel rebuild every time an autotile advanced.
        key = [atlas_key, origin[0], origin[1], atlas.width, atlas.height,
               terrain_signature(state[:records])]
        texture = state[:terrain_data_texture]
        if state[:terrain_data_key] == key &&
           state[:terrain_data_origin] == origin &&
           state[:terrain_data_atlas_key] == atlas_key &&
           texture && !texture.disposed?
          return texture
        end
        pending = state[:terrain_data_pending]
        unless pending && pending[:key] == key &&
               pending[:atlas_width] == atlas.width &&
               pending[:atlas_height] == atlas.height
          if pending && pending[:texture] && !pending[:texture].disposed?
            pending[:texture].dispose
          end
          state[:terrain_data_pending] = nil
          # Query the atlas-wide terrain cells only on an actual cache miss.
          # Previously this allocation and sort happened before the fast return
          # above, so every rendered frame rebuilt hundreds of entry hashes
          # even while the completed height texture was unchanged.
          atlas_bounds = [origin[0], origin[1],
                          origin[0] + atlas.width, origin[1] + atlas.height]
          atlas_entries = visible_terrain_entries(state, atlas_bounds)
          pending = {
            :key => key, :atlas_width => atlas.width, :atlas_height => atlas.height,
            :origin => origin.dup, :atlas_key => atlas_key,
            :entries => atlas_entries, :index => 0,
            # String#[]= uses character offsets for UTF-8. Height/flag bytes
            # make that encoding invalid and every overlap row then scans
            # the preceding atlas again, causing multi-second scroll stalls.
            :bytes => "\0".b * (atlas.width * atlas.height * 4),
            :texture => Bitmap.new(atlas.width, atlas.height)
          }
          # Keep the completed CPU bytes so an atlas move copies unchanged
          # geometry instead of spending many frames resampling every cell.
          # Revision changes deliberately take the full rebuild path.
          old_origin = state[:terrain_data_origin]
          old_bytes = state[:terrain_data_bytes]
          old_key = state[:terrain_data_key]
          if old_bytes && old_origin && old_key && texture && !texture.disposed? &&
             old_key[0][4] == atlas_key[4] && old_key[-1] == key[-1]
            left = [origin[0], old_origin[0]].max
            top = [origin[1], old_origin[1]].max
            right = [origin[0] + atlas.width, old_origin[0] + texture.width].min
            bottom = [origin[1] + atlas.height, old_origin[1] + texture.height].min
            if left < right && top < bottom
              count = (right - left) * 4
              (top...bottom).each do |y|
                src = ((y - old_origin[1]) * texture.width + left - old_origin[0]) * 4
                dest = ((y - origin[1]) * atlas.width + left - origin[0]) * 4
                pending[:bytes][dest, count] = old_bytes.byteslice(src, count)
              end
              pending[:entries] = atlas_entries.reject do |entry|
                x = entry[:origin_x] + entry[:x] * TILE_SIZE
                y = entry[:origin_y] + entry[:y] * TILE_SIZE
                x >= left && y >= top && x + TILE_SIZE <= right && y + TILE_SIZE <= bottom
              end
            end
          end
          state[:terrain_data_pending] = pending
        end
        pending = state[:terrain_data_pending]
        if pending
          budget = [PSEUDO3D_TERRAIN_DATA_CELLS_PER_FRAME.to_i, 1].max
          processed = 0
          while pending[:index] < pending[:entries].length && processed < budget
            entry = pending[:entries][pending[:index]]
            cell = entry[:cell]
            left = entry[:origin_x] + entry[:x] * TILE_SIZE - origin[0]
            top = entry[:origin_y] + entry[:y] * TILE_SIZE - origin[1]
            overpass = MakerStudio.terrain_overpass?(cell) ? 255 : 0
            TILE_SIZE.times do |py|
              data_y = top + py
              next if data_y < 0 || data_y >= atlas.height
              v = (py + 0.5) / TILE_SIZE.to_f
              TILE_SIZE.times do |px|
                data_x = left + px
                next if data_x < 0 || data_x >= atlas.width
                u = (px + 0.5) / TILE_SIZE.to_f
                height = terrain_level_height(entry[:map].map_id, cell, u, v)
                offset = (data_y * atlas.width + data_x) * 4
                pending[:bytes].setbyte(offset, [[height.round, 0].max, 255].min)
                pending[:bytes].setbyte(offset + 1, overpass)
                pending[:bytes].setbyte(offset + 2, 255)
                pending[:bytes].setbyte(offset + 3, 255)
              end
            end
            pending[:index] += 1
            processed += 1
          end
          if pending[:index] >= pending[:entries].length
            candidate = pending[:texture]
            candidate.raw_data = pending[:bytes]
            old_texture = state[:terrain_data_texture]
            old_render_atlas = state[:terrain_render_atlas]
            state[:terrain_data_texture] = candidate
            state[:terrain_data_bytes] = pending[:bytes]
            state[:terrain_data_key] = key
            state[:terrain_data_origin] = pending[:origin]
            state[:terrain_data_atlas_key] = pending[:atlas_key]
            state[:terrain_render_atlas] = atlas
            state[:terrain_render_origin] = pending[:origin]
            state[:terrain_render_atlas_key] = pending[:atlas_key]
            state[:terrain_data_pending] = nil
            retired = state[:terrain_retired_resources] ||= []
            retired << old_texture if old_texture && old_texture != candidate
            if old_render_atlas && old_render_atlas != atlas &&
               !retired.include?(old_render_atlas)
              retired << old_render_atlas
            end
            return candidate
          end
          # Keep the last complete height texture bound while the replacement
          # is assembled. Returning nil here makes the caller disable all
          # terrain shaders for a frame, which manifests as terrain popping
          # out and the camera projection reverting temporarily.
          # A texture from the previous atlas is still safe for already
          # configured sprites, but must never be rebound with the new atlas
          # origin. Callers can keep those sprites untouched until this build
          # completes.
          return texture if texture && !texture.disposed? &&
                            state[:terrain_render_atlas] &&
                            !state[:terrain_render_atlas].disposed?
          return nil
        end
        texture
      end

      def dispose_retired_terrain_resources(state)
        active = [state[:ground_atlas], state[:terrain_render_atlas],
                  state[:terrain_data_texture]]
        retired = state[:terrain_retired_resources] || []
        retired.each do |resource|
          next unless resource && !active.include?(resource)
          resource.dispose unless resource.disposed?
        end
        state[:terrain_retired_resources] = []
      end

      def render_terrain_shaders(state, camera, display_x, display_y, atlas,
                                 entries, tone, color)
        shaders = [state[:terrain_shader], state[:foreground_shader],
                   state[:overpass_shader]]
        return false unless shaders.all? { |shader| shader_alive?(shader) }
        terrain_data = prepare_terrain_data(state, atlas, entries)
        unless terrain_data && !terrain_data.disposed?
          # There is no completed colour/height pair yet (normally only on the
          # first scene frame). Once a pair exists, prepare_terrain_data keeps
          # returning it until the replacement pair is complete.
          [state[:terrain_sprite], state[:foreground_sprite],
           state[:overpass_sprite]].each do |sprite|
            sprite.visible = false if sprite && !sprite.disposed?
          end
          return false
        end
        render_atlas = state[:terrain_render_atlas]
        origin = state[:terrain_render_origin]
        unless render_atlas && !render_atlas.disposed? && origin
          [state[:terrain_sprite], state[:foreground_sprite],
           state[:overpass_sprite]].each do |sprite|
            sprite.visible = false if sprite && !sprite.disposed?
          end
          return false
        end
        # Layer availability and maximum elevation must describe the same
        # atlas/height pair being rendered. Using the moving current-frustum
        # list here could hide a whole pass one frame before the old atlas was
        # atomically replaced, which looked like terrain blinking out.
        # Normal terrain is one surface pass; each receiver resolves its own
        # depth. A split at the player's world Y cannot sort another event or
        # a translucent beam, and changes meaning when the camera rotates.
        player_foot_y = 1_000_000_000.0
        foreground_z = nil
        # A Sprite with a shader still costs a complete-screen draw whenever it
        # is visible. Work out which render modes can actually contribute before
        # configuring them: ordinary maps commonly have no overpass and no
        # player-side foreground at all, yet the old code paid for three ray
        # intersection passes every frame.
        surface_info = state[:terrain_surface_info]
        if surface_info && surface_info[0].equal?(terrain_data)
          active_modes, max_terrain_height, terrain_bounds = surface_info[1..3]
        else
          render_bounds = [origin[0], origin[1],
                           origin[0] + render_atlas.width,
                           origin[1] + render_atlas.height]
          entries = visible_terrain_entries(state, render_bounds)
          has_background = false
          has_foreground = false
          has_overpass = false
          max_terrain_height = 0.0
          entries.each do |entry|
            cell = entry[:cell]
            next unless cell
            cell_height = terrain_corners(entry[:map].map_id, cell).max
            max_terrain_height = cell_height if cell_height > max_terrain_height
            if MakerStudio.terrain_overpass?(cell)
              has_overpass = true
            else
              has_background = true
            end
          end
          active_modes = [has_background, has_foreground, has_overpass]
          terrain_bounds = entries.each_with_object(
            [Float::INFINITY, Float::INFINITY, -Float::INFINITY, -Float::INFINITY]
          ) do |entry, result|
            left = entry[:origin_x].to_f + entry[:x].to_f * TILE_SIZE
            top = entry[:origin_y].to_f + entry[:y].to_f * TILE_SIZE
            result[0] = left if left < result[0]
            result[1] = top if top < result[1]
            result[2] = left + TILE_SIZE if left + TILE_SIZE > result[2]
            result[3] = top + TILE_SIZE if top + TILE_SIZE > result[3]
          end
          state[:terrain_surface_info] = [terrain_data, active_modes, max_terrain_height, terrain_bounds]
        end
        # Ground fog/cloud shadows need the same layer split as authored
        # terrain. A single fixed-Z fog Sprite either disappears below the
        # foreground terrain or paints over the player. Keep the classification
        # data from this exact colour/height pair for render_fog_shaders.
        state[:terrain_render_modes] = active_modes
        state[:terrain_player_foot_y] = player_foot_y
        state[:terrain_foreground_z] = foreground_z
        state[:max_terrain_height] = max_terrain_height
        state[:terrain_bounds] = terrain_bounds
        screen_key = [camera.object_id, display_x, display_y, terrain_data.object_id]
        if state[:occlusion_screen_key] != screen_key
          state[:occlusion_screen_key] = screen_key
          if max_terrain_height > 0
            points = []
            [terrain_bounds[0], terrain_bounds[2]].each do |x|
              [terrain_bounds[1], terrain_bounds[3]].each do |y|
                [0.0, max_terrain_height].each { |h| points << project_point(x-display_x, y-display_y, h) }
              end
            end
            state[:occlusion_screen_bounds] = if points.all?
              [points.map { |p| p[0] }.min-2, points.map { |p| p[1] }.min-2,
               points.map { |p| p[0] }.max+2, points.map { |p| p[1] }.max+2]
            end
          else
            state[:occlusion_screen_bounds] = nil
          end
        end
        @occlusion_state = state
        layers = [
          [state[:terrain_sprite], state[:terrain_shader], 0, -80],
          [state[:foreground_sprite], state[:foreground_shader], 1,
           foreground_z || OVERPASS_LAYER_Z - 1],
          [state[:overpass_sprite], state[:overpass_shader], 2, OVERPASS_LAYER_Z]
        ]
        layers.each_with_index do |(sprite, shader, mode, z), index|
          enabled = active_modes[index]
          sprite.visible = false unless enabled
          next unless enabled
          configure_projection_shader(shader, camera, display_x, display_y,
                                      render_atlas, origin, terrain_data)
          shader.set_int("renderMode", mode)
          shader.set_float("playerFootY", player_foot_y)
          shader.set_float("tileSize", TILE_SIZE.to_f)
          shader.set_float("maxTerrainHeight", max_terrain_height)
          shader.set_vec4("terrainBounds", *terrain_bounds)
          configure_fullscreen_sprite(sprite, render_atlas, z)
          sprite.tone = lighting_tone(tone) || tone || Tone.new(0, 0, 0, 0)
          sprite.color = color if color
          sprite.visible = true
        end
        dispose_retired_terrain_resources(state)
        true
      rescue => error
        Console.echo_error(
          "Pseudo3D terrain shader render: #{error.message}"
        ) if defined?(Console)
        [state[:terrain_sprite], state[:foreground_sprite],
         state[:overpass_sprite]].each do |sprite|
          sprite.visible = false if sprite && !sprite.disposed?
        end
        false
      end

      def configure_world_shader(shader, camera, display_x, display_y)
        unless shader.instance_variable_get(:@p3d_world_camera).equal?(camera)
          shader.instance_variable_set(:@p3d_world_camera, camera)
          shader.set_vec2("cameraCenter", camera[:center_x], camera[:center_y])
          shader.set_float("cameraBack", camera[:back])
          shader.set_float("cameraHeight", camera[:height])
          shader.set_float("cameraSinPitch", camera[:sin_pitch])
          shader.set_float("cameraCosPitch", camera[:cos_pitch])
          shader.set_float("cameraFocal", camera[:focal])
          shader.set_float("cameraSinYaw", camera[:sin_yaw])
          shader.set_float("cameraCosYaw", camera[:cos_yaw])
        end
        shader.set_vec2("displayPosition", display_x, display_y)
      end

      def shadow_quad(record)
        angle = MapSettings.value(:PSEUDO3D_SHADOW_ANGLE_DEGREES).to_f * Math::PI / 180.0
        direction_x = Math.cos(angle)
        direction_y = Math.sin(angle)
        perpendicular_x = -direction_y
        perpendicular_y = direction_x
        width = record[:width].to_f
        length = record[:length].to_f * [MapSettings.value(:PSEUDO3D_SHADOW_LENGTH).to_f, 0.0].max
        return nil if width <= 0.0 || length <= 0.0
        start_x = record[:x].to_f - direction_x * width * 0.18
        start_y = record[:y].to_f - direction_y * width * 0.18
        end_x = start_x + direction_x * length
        end_y = start_y + direction_y * length
        half_width = width * 0.5
        points = [
          [start_x - perpendicular_x * half_width, start_y - perpendicular_y * half_width],
          [start_x + perpendicular_x * half_width, start_y + perpendicular_y * half_width],
          [end_x + perpendicular_x * half_width * 0.55,
           end_y + perpendicular_y * half_width * 0.55],
          [end_x - perpendicular_x * half_width * 0.55,
           end_y - perpendicular_y * half_width * 0.55]
        ]
        [points, points.map { |point| shadow_height_at(point[0], point[1], record) }]
      end

      def render_shadow_shaders(renderer, state, records, camera, display_x, display_y)
        overlays = state[:shadow_overlays] ||= {}
        active = {}
        texture = shadow_texture(state)
        native_corners = Sprite.instance_methods.include?(:corners=)
        records.each do |record|
          owner = record[:character] || record[:instance]
          next unless owner
          key = owner.object_id
          entry = overlays[key]
          entry_valid = entry && entry[:sprite] && !entry[:sprite].disposed? &&
                        ((native_corners && entry[:native_corners]) ||
                         (!entry[:native_corners] && shader_alive?(entry[:shader])))
          unless entry_valid
            entry[:sprite].dispose if entry && entry[:sprite] && !entry[:sprite].disposed?
            entry[:shader].dispose if entry && shader_alive?(entry[:shader])
            shader = native_corners ? nil : create_shadow_shader
            next unless native_corners || shader
            sprite = Sprite.new(renderer.viewport)
            sprite.shader = shader if shader
            entry = overlays[key] = {
              :sprite => sprite, :shader => shader,
              :native_corners => native_corners
            }
            sprite.bitmap = texture
            sprite.src_rect.set(0, 0, texture.width, texture.height)
            sprite.x = 0
            sprite.y = 0
            sprite.ox = 0
            sprite.oy = 0
            sprite.zoom_x = 1.0
            sprite.zoom_y = 1.0
            sprite.opacity = MapSettings.value(:PSEUDO3D_SHADOW_OPACITY).to_i
            sprite.blend_type = 0
            sprite.tone = Tone.new(0, 0, 0, 0)
            sprite.color = Color.new(0, 0, 0, 0)
          end
          sprite = entry[:sprite]
          shader = entry[:shader]
          sprite.bitmap = texture unless sprite.bitmap == texture
          if record[:on_overpass]
            # The overpass terrain itself is 5000 and its character is 5001.
            # Equal-Z creation order puts this later-created shadow over the
            # terrain while the character remains one integer above it.
            sprite.z = OVERPASS_LAYER_Z
          else
            # mkxp-z stores Sprite Z as an integer. Sort each contact shadow
            # immediately below its owner's projected foot instead of at a
            # fixed negative layer, otherwise elevated/foreground terrain
            # hides player and NPC shadows.
            sort_z = ground_sort_z(record[:x].to_f - display_x,
                                   record[:y].to_f - display_y, 0.0,
                                   record[:elevation].to_f)
            sprite.z = sort_z ? sort_z.floor - 1 : -70
          end
          surface = record[:character]&.instance_variable_get(:@maker_studio_terrain_surface)
          quad_key = [record[:x], record[:y], record[:width], record[:length],
                      record[:elevation], record[:on_overpass], surface,
                      (MakerStudio.terrain_revision($game_map.map_id) rescue nil)]
          if entry[:quad_key] != quad_key
            quad = shadow_quad(record)
            next unless quad
            entry[:quad_key] = quad_key
            entry[:quad] = quad
            unless entry[:native_corners]
              quad[0].each_with_index do |point, index|
                shader.set_vec3("world#{index}", point[0], point[1], quad[1][index])
              end
            end
          end
          if entry[:native_corners]
            # mkxp-z-ext exposes a native four-corner Sprite quad. It is both
            # cheaper and more reliable for a handful of contact shadows than
            # compiling one custom vertex shader per owner.
            projected = entry[:quad][0].each_with_index.map do |point, index|
              project_point(point[0] - display_x, point[1] - display_y,
                            entry[:quad][1][index])
            end
            if projected.any?(&:nil?)
              sprite.visible = false
              next
            end
            sprite.corners = projected.flat_map { |point| [point[0], point[1]] }
          else
            configure_world_shader(shader, camera, display_x, display_y)
          end
          sprite.visible = true
          active[key] = true
        end
        overlays.keys.each do |key|
          next if active[key]
          entry = overlays.delete(key)
          entry[:sprite].dispose if entry[:sprite] && !entry[:sprite].disposed?
          entry[:shader].dispose if shader_alive?(entry[:shader])
        end
      rescue => error
        Console.echo_error(
          "Pseudo3D shadow shader render: #{error.message}"
        ) if defined?(Console)
      end

      def render_fog_shaders(renderer, state, layers, camera, display_x, display_y,
                             atlas, terrain_data)
        update_object_fog_layers(layers)
        overlays = state[:fog_overlays] ||= {}
        active = {}
        origin = state[:terrain_render_origin] || state[:ground_atlas_origin]
        render_modes = state[:terrain_render_modes] || [true, false, false]
        foreground_z = state[:terrain_foreground_z]
        fog_modes = [
          [0, true, -65],
          [1, render_modes[1], foreground_z ? foreground_z + 1 : nil],
          [2, render_modes[2], OVERPASS_LAYER_Z]
        ]
        layers.each do |layer|
          source = layer[:sprite]
          next unless source && source.bitmap && !source.bitmap.disposed?
          fog_modes.each do |mode, enabled, z|
            next unless enabled && z
            key = [layer[:map].map_id, source.object_id, mode]
            entry = overlays[key]
            unless entry && entry[:sprite] && !entry[:sprite].disposed? &&
                   shader_alive?(entry[:shader])
              entry[:sprite].dispose if entry && entry[:sprite] && !entry[:sprite].disposed?
              entry[:shader].dispose if entry && shader_alive?(entry[:shader])
              shader = create_fog_shader
              next unless shader
              sprite = Sprite.new(renderer.viewport)
              sprite.shader = shader
              entry = overlays[key] = { :sprite => sprite, :shader => shader }
            end
            sprite = entry[:sprite]
            shader = entry[:shader]
            bitmap = source.bitmap
            configure_projection_shader(shader, camera, display_x, display_y,
                                        atlas, origin, terrain_data)
            map_display_x = layer[:map].display_x.to_f / Game_Map::X_SUBPIXELS
            map_display_y = layer[:map].display_y.to_f / Game_Map::Y_SUBPIXELS
            parallax = layer[:follow] ? 0.0 : layer[:parallax].to_f
            offset_x = -map_display_x * (1.0 - parallax) + layer[:scroll_x]
            offset_y = -map_display_y * (1.0 - parallax) + layer[:scroll_y]
            shader.set_vec2("mapOrigin", layer[:origin_x].to_f, layer[:origin_y].to_f)
            shader.set_vec2("mapSize", layer[:map].width * TILE_SIZE.to_f,
                            layer[:map].height * TILE_SIZE.to_f)
            shader.set_vec2("textureWorldSize",
                            bitmap.width * [source.zoom_x.to_f, 0.1].max,
                            bitmap.height * [source.zoom_y.to_f, 0.1].max)
            shader.set_vec2("textureOffset", offset_x, offset_y)
            shader.set_vec2("cloudHeightDirection", *cloud_height_direction)
            shader.set_int("renderMode", mode)
            shader.set_float("playerFootY", state[:terrain_player_foot_y].to_f)
            shader.set_float("tileSize", TILE_SIZE.to_f)
            shader.set_float("maxTerrainHeight", state[:max_terrain_height].to_f)
            shader.set_float("layerOpacity", source.opacity.to_f / 255.0)
            shader.set_vec4("terrainBounds", *(state[:terrain_bounds] ||
                              [origin[0], origin[1], origin[0] + atlas.width,
                               origin[1] + atlas.height]))
            configure_fullscreen_sprite(sprite, bitmap, z)
            # Opacity is consumed in fog_projection.frag. Keep the RGSS Sprite
            # neutral so mkxp-z cannot apply the same factor a second time.
            sprite.opacity = 255
            sprite.blend_type = source.blend_type
            sprite.tone = source.tone
            sprite.color = source.color
            sprite.visible = source.opacity.to_i > 0
            active[key] = true
          end
        end
        overlays.keys.each do |key|
          next if active[key]
          entry = overlays.delete(key)
          entry[:sprite].dispose if entry[:sprite] && !entry[:sprite].disposed?
          entry[:shader].dispose if shader_alive?(entry[:shader])
        end
      rescue => error
        Console.echo_error(
          "Pseudo3D fog shader render: #{error.message}"
        ) if defined?(Console)
      end

      def terrain_corners(map_id, cell)
        if defined?(MakerStudio) && MakerStudio.respond_to?(:terrain_corner_heights)
          MakerStudio.terrain_corner_heights(map_id, cell)
        else
          [0.0, 0.0, 0.0, 0.0]
        end
      end

      def visible_terrain_entries(state, bounds)
        return [] unless defined?(MakerStudio) && MakerStudio.respond_to?(:terrain_render_cells)
        ranges = []
        state[:records].each do |map, origin_x, origin_y|
          min_x = [((bounds[0] - origin_x) / TILE_SIZE).floor, 0].max
          min_y = [((bounds[1] - origin_y) / TILE_SIZE).floor, 0].max
          max_x = [((bounds[2] - origin_x) / TILE_SIZE).ceil, map.width - 1].min
          max_y = [((bounds[3] - origin_y) / TILE_SIZE).ceil, map.height - 1].min
          next if min_x > max_x || min_y > max_y
          ranges << [map, origin_x, origin_y, min_x, min_y, max_x, max_y]
        end
        # Perspective bounds move every subpixel, but the terrain query only
        # changes after crossing a tile boundary. Retain a few recent tile
        # ranges because the visible-frustum and atlas-wide callers alternate
        # every frame and need separate entries.
        cache_key = [state[:signature], terrain_signature(state[:records]),
                     ranges.map do |map, origin_x, origin_y, min_x, min_y, max_x, max_y|
                       [map.map_id, origin_x, origin_y, min_x, min_y, max_x, max_y]
                     end]
        cache = state[:terrain_entries_cache] ||= {}
        state[:terrain_entries_cache_clock] = state[:terrain_entries_cache_clock].to_i + 1
        cached = cache[cache_key]
        if cached
          cached[:clock] = state[:terrain_entries_cache_clock]
          return cached[:entries]
        end
        result = []
        ranges.each do |map, origin_x, origin_y, min_x, min_y, max_x, max_y|
          MakerStudio.terrain_render_cells(map.map_id, min_x, min_y, max_x, max_y).each do |x, y, cell|
            result << {
              :map => map, :origin_x => origin_x, :origin_y => origin_y,
              :x => x, :y => y, :cell => cell
            }
          end
        end
        result.sort_by! { |entry| [entry[:map].map_id, entry[:y], entry[:x]] }
        cache[cache_key] = {
          :entries => result, :clock => state[:terrain_entries_cache_clock]
        }
        if cache.length > 4
          oldest_key, = cache.min_by { |_key, value| value[:clock] }
          cache.delete(oldest_key)
        end
        result
      end

      def prepare_terrain_atlas(renderer, state, entries)
        return nil if entries.empty?
        key = [state[:signature], state[:animation_signature], entries.map do |entry|
          cell = entry[:cell]
           [entry[:map].map_id, entry[:x], entry[:y], cell["height"], cell["slope"],
            cell["type"], cell["style"]]
        end]
        entries.each_with_index { |entry, index| entry[:atlas_index] = index }
        atlas = state[:terrain_atlas]
        return atlas if state[:terrain_atlas_key] == key && atlas && !atlas.disposed?

        columns = [[Math.sqrt(entries.length).ceil, 1].max, 64].min
        rows = (entries.length.to_f / columns).ceil
        width = columns * TILE_SIZE
        height = rows * TILE_SIZE
        if !atlas || atlas.disposed? || atlas.width != width || atlas.height != height
          atlas.dispose if atlas && !atlas.disposed?
          atlas = Bitmap.new(width, height)
          state[:terrain_atlas] = atlas
        else
          atlas.clear
        end
        source_rect = Rect.new(0, 0, TILE_SIZE, TILE_SIZE)
        entries.each_with_index do |entry, index|
          world_x = entry[:origin_x] + entry[:x] * TILE_SIZE
          world_y = entry[:origin_y] + entry[:y] * TILE_SIZE
          chunk_x = world_x.div(CHUNK_SIZE)
          chunk_y = world_y.div(CHUNK_SIZE)
          chunk = chunk_for(renderer, state, chunk_x, chunk_y)
          next unless chunk
          source_rect.set(world_x - chunk_x * CHUNK_SIZE,
                          world_y - chunk_y * CHUNK_SIZE, TILE_SIZE, TILE_SIZE)
          atlas.blt((index % columns) * TILE_SIZE, (index / columns) * TILE_SIZE,
                    chunk, source_rect)
        end
        state[:terrain_atlas_key] = key
        state[:terrain_atlas_columns] = columns
        atlas
      end

      def mesh_quad(vertices, indices, points)
        base = vertices.length / 7
        points.each { |point| vertices.concat(point) }
        indices.concat([base, base + 1, base + 2, base, base + 2, base + 3])
      end

      def mesh_triangle(vertices, indices, points)
        base = vertices.length / 7
        points.each { |point| vertices.concat(point) }
        indices.concat([base, base + 1, base + 2])
      end

      def distance_alpha(world_y, camera_ground_y)
        distance = camera_ground_y - world_y.to_f
        fade_start = far_distance * 0.86
        return 0.0 if distance >= far_distance
        return 1.0 if distance <= fade_start
        (far_distance - distance) / (far_distance - fade_start)
      end

      def mesh_config(camera, display_x, display_y, opacity = 1.0,
                      blend_type = 0, repeat = false, tone = nil)
        tone_values = if tone
                        [tone.red.to_f, tone.green.to_f, tone.blue.to_f, tone.gray.to_f]
                      else
                        [0.0, 0.0, 0.0, 0.0]
                      end
        [display_x + camera[:center_x], camera[:center_y],
         display_y + camera[:center_y] + camera[:back], camera[:height],
         effective_pitch_degrees * Math::PI / 180.0, camera[:focal],
         Graphics.width.to_f, Graphics.height.to_f, opacity.to_f,
         blend_type.to_f, repeat ? 1.0 : 0.0] + tone_values + [1.0]
      end

      def terrain_edge_profile(style)
        case style
        when "soft"
          [[0.34, 0.0], [0.24, 0.20], [0.11, 0.56], [0.0, 1.0]]
        when "round"
          [[0.38, 0.0], [0.35, 0.04], [0.29, 0.15], [0.21, 0.35],
           [0.11, 0.66], [0.0, 1.0]]
        else
          [[0.0, 0.0], [0.0, 1.0]]
        end
      end

      def terrain_profile_point(point, other, outward, distance, expand)
        length = Math.sqrt((other[0] - point[0]) ** 2 + (other[1] - point[1]) ** 2)
        tangent_x = length > 0.001 ? (other[0] - point[0]) / length : 0.0
        tangent_y = length > 0.001 ? (other[1] - point[1]) / length : 0.0
        # At a corner shared by two exposed edges, both profiles follow the
        # same inset ring. This closes the cut corner without extending into
        # either neighboring tile.
        tangent_distance = expand ? distance : 0.0
        [point[0] - outward[0] * distance + tangent_x * tangent_distance,
         point[1] - outward[1] * distance + tangent_y * tangent_distance]
      end

      def append_terrain_edge(vertices, indices, a, b, top_a, top_b,
                              bottom_a, bottom_b, uv_a, uv_b,
                              alpha_a, alpha_b, style, outward,
                              expand_a = true, expand_b = true)
        return if top_a <= bottom_a + 0.001 && top_b <= bottom_b + 0.001
        low_a = [bottom_a, top_a].min
        low_b = [bottom_b, top_b].min
        profile = terrain_edge_profile(style)
        (0...(profile.length - 1)).each do |index|
          distance_0, drop_0 = profile[index]
          distance_1, drop_1 = profile[index + 1]
          distance_0 *= TILE_SIZE
          distance_1 *= TILE_SIZE
          a0 = terrain_profile_point(a, b, outward, distance_0, expand_a)
          b0 = terrain_profile_point(b, a, outward, distance_0, expand_b)
          a1 = terrain_profile_point(a, b, outward, distance_1, expand_a)
          b1 = terrain_profile_point(b, a, outward, distance_1, expand_b)
          height_a0 = top_a + (low_a - top_a) * drop_0
          height_b0 = top_b + (low_b - top_b) * drop_0
          height_a1 = top_a + (low_a - top_a) * drop_1
          height_b1 = top_b + (low_b - top_b) * drop_1
          light = 0.92 - drop_0 * 0.20
          mesh_quad(vertices, indices, [
            [a0[0], a0[1], height_a0, uv_a[0], uv_a[1], light, alpha_a],
            [b0[0], b0[1], height_b0, uv_b[0], uv_b[1], light, alpha_b],
            [b1[0], b1[1], height_b1, uv_b[0], uv_b[1], light, alpha_b],
            [a1[0], a1[1], height_a1, uv_a[0], uv_a[1], light, alpha_a]
          ])
        end
      end

      def terrain_edge_bottoms(map_id, cell, neighbor, top_a, top_b,
                               neighbor_a, neighbor_b)
        return [neighbor_a, neighbor_b] unless MakerStudio.terrain_overpass?(cell)
        thickness = [MakerStudio::TERRAIN_OVERPASS_THICKNESS,
                     MakerStudio.terrain_height_step(map_id) * 0.5].min
        [[neighbor_a, top_a - thickness].max,
         [neighbor_b, top_b - thickness].max]
      end

      def corner_slope?(cell)
        slope = cell ? cell["slope"].to_s : ""
        slope.start_with?("outer_") || slope.start_with?("inner_")
      end

      def terrain_level_height(map_id, cell, u, v)
        if defined?(MakerStudio) && MakerStudio.respond_to?(:terrain_surface_level_at)
          MakerStudio.terrain_surface_level_at(cell, u, v) *
            MakerStudio.terrain_height_step(map_id)
        else
          0.0
        end
      end

      def terrain_edge_exposed?(map_id, cell, neighbor, direction)
        samples = [0.0, 0.5, 1.0]
        samples.any? do |position|
          case direction
          when :north
            current = [position, 0.0]; adjacent = [position, 1.0]
          when :east
            current = [1.0, position]; adjacent = [0.0, position]
          when :south
            current = [position, 1.0]; adjacent = [position, 0.0]
          else
            current = [0.0, position]; adjacent = [1.0, position]
          end
          top = terrain_level_height(map_id, cell, current[0], current[1])
          low = terrain_level_height(map_id, neighbor, adjacent[0], adjacent[1])
          bottom = terrain_edge_bottoms(map_id, cell, neighbor, top, top, low, low)[0]
          top > bottom + 0.001
        end
      end

      def terrain_top_insets(cell, exposed)
        empty = { :north => 0.0, :east => 0.0, :south => 0.0, :west => 0.0 }
        return empty if corner_slope?(cell) || MakerStudio.terrain_overpass?(cell)
        profile = terrain_edge_profile(MakerStudio.terrain_edge_style(cell))
        inset = profile[0][0] * TILE_SIZE
        return empty if inset <= 0.001
        exposed.each_key { |direction| empty[direction] = inset if exposed[direction] }
        empty
      end

      def append_terrain_top(vertices, indices, map_id, cell, x0, y0,
                             u0, v0, u1, v1, camera_ground_y, insets = nil)
        slope = cell && cell["slope"].to_s
        divisions = corner_slope?(cell) ? 10 : 1
        outer_corner = slope && slope.start_with?("outer_")
        base_height = [cell && cell["height"].to_f || 0.0, 0.0].max *
                      MakerStudio.terrain_height_step(map_id)
        insets ||= {}
        local_left = (insets[:west] || 0.0) / TILE_SIZE
        local_right = 1.0 - (insets[:east] || 0.0) / TILE_SIZE
        local_top = (insets[:north] || 0.0) / TILE_SIZE
        local_bottom = 1.0 - (insets[:south] || 0.0) / TILE_SIZE
        divisions.times do |grid_y|
          grid_v0 = grid_y.to_f / divisions
          grid_v1 = (grid_y + 1).to_f / divisions
          local_v0 = local_top + (local_bottom - local_top) * grid_v0
          local_v1 = local_top + (local_bottom - local_top) * grid_v1
          world_y0 = y0 + local_v0 * TILE_SIZE
          world_y1 = y0 + local_v1 * TILE_SIZE
          alpha_0 = distance_alpha(world_y0, camera_ground_y)
          alpha_1 = distance_alpha(world_y1, camera_ground_y)
          divisions.times do |grid_x|
            grid_u0 = grid_x.to_f / divisions
            grid_u1 = (grid_x + 1).to_f / divisions
            local_u0 = local_left + (local_right - local_left) * grid_u0
            local_u1 = local_left + (local_right - local_left) * grid_u1
            world_x0 = x0 + local_u0 * TILE_SIZE
            world_x1 = x0 + local_u1 * TILE_SIZE
            texture_u0 = u0 + (u1 - u0) * local_u0
            texture_u1 = u0 + (u1 - u0) * local_u1
            texture_v0 = v0 + (v1 - v0) * local_v0
            texture_v1 = v0 + (v1 - v0) * local_v1
            points = [
              [world_x0, world_y0, terrain_level_height(map_id, cell, local_u0, local_v0),
               texture_u0, texture_v0, 1.0, alpha_0],
              [world_x1, world_y0, terrain_level_height(map_id, cell, local_u1, local_v0),
               texture_u1, texture_v0, 1.0, alpha_0],
              [world_x1, world_y1, terrain_level_height(map_id, cell, local_u1, local_v1),
               texture_u1, texture_v1, 1.0, alpha_1],
              [world_x0, world_y1, terrain_level_height(map_id, cell, local_u0, local_v1),
               texture_u0, texture_v1, 1.0, alpha_1]
            ]
            if outer_corner
              first = [points[0], points[1], points[2]]
              second = [points[0], points[2], points[3]]
              mesh_triangle(vertices, indices, first) if first.any? { |point| point[2] > base_height + 0.001 }
              mesh_triangle(vertices, indices, second) if second.any? { |point| point[2] > base_height + 0.001 }
            else
              mesh_quad(vertices, indices, points)
            end
          end
        end
      end

      def append_sampled_terrain_edge(vertices, indices, map_id, cell, neighbor,
                                      direction, x0, y0, uv0, uv1, camera_ground_y,
                                      expand_a = false, expand_b = false)
        divisions = corner_slope?(cell) || corner_slope?(neighbor) ? 10 : 1
        style = MakerStudio.terrain_overpass?(cell) ? "hard" :
                MakerStudio.terrain_edge_style(cell)
        outward = { :north => [0.0, -1.0], :east => [1.0, 0.0],
                    :south => [0.0, 1.0], :west => [-1.0, 0.0] }[direction]
        divisions.times do |part|
          t0 = part.to_f / divisions
          t1 = (part + 1).to_f / divisions
          case direction
          when :north
            a = [x0 + t0 * TILE_SIZE, y0]
            b = [x0 + t1 * TILE_SIZE, y0]
            current_a = [t0, 0.0]; current_b = [t1, 0.0]
            neighbor_a = [t0, 1.0]; neighbor_b = [t1, 1.0]
          when :east
            a = [x0 + TILE_SIZE, y0 + t0 * TILE_SIZE]
            b = [x0 + TILE_SIZE, y0 + t1 * TILE_SIZE]
            current_a = [1.0, t0]; current_b = [1.0, t1]
            neighbor_a = [0.0, t0]; neighbor_b = [0.0, t1]
          when :south
            a = [x0 + t0 * TILE_SIZE, y0 + TILE_SIZE]
            b = [x0 + t1 * TILE_SIZE, y0 + TILE_SIZE]
            current_a = [t0, 1.0]; current_b = [t1, 1.0]
            neighbor_a = [t0, 0.0]; neighbor_b = [t1, 0.0]
          else
            a = [x0, y0 + t0 * TILE_SIZE]
            b = [x0, y0 + t1 * TILE_SIZE]
            current_a = [0.0, t0]; current_b = [0.0, t1]
            neighbor_a = [1.0, t0]; neighbor_b = [1.0, t1]
          end
          top_a = terrain_level_height(map_id, cell, current_a[0], current_a[1])
          top_b = terrain_level_height(map_id, cell, current_b[0], current_b[1])
          low_a = terrain_level_height(map_id, neighbor, neighbor_a[0], neighbor_a[1])
          low_b = terrain_level_height(map_id, neighbor, neighbor_b[0], neighbor_b[1])
          bottoms = terrain_edge_bottoms(map_id, cell, neighbor, top_a, top_b, low_a, low_b)
          edge_uv_a = [uv0[0] + (uv1[0] - uv0[0]) * t0,
                       uv0[1] + (uv1[1] - uv0[1]) * t0]
          edge_uv_b = [uv0[0] + (uv1[0] - uv0[0]) * t1,
                       uv0[1] + (uv1[1] - uv0[1]) * t1]
          append_terrain_edge(vertices, indices, a, b, top_a, top_b,
                              bottoms[0], bottoms[1], edge_uv_a, edge_uv_b,
                              distance_alpha(a[1], camera_ground_y),
                              distance_alpha(b[1], camera_ground_y), style, outward,
                              expand_a && part == 0,
                              expand_b && part == divisions - 1)
        end
      end

      def build_terrain_mesh(state, entries, atlas, camera, display_y)
        vertices = []
        indices = []
        columns = state[:terrain_atlas_columns]
        camera_ground_y = display_y + camera[:center_y] + camera[:back]
        entries.each do |entry|
          map = entry[:map]
          x = entry[:x]
          y = entry[:y]
          x0 = entry[:origin_x] + x * TILE_SIZE
          y0 = entry[:origin_y] + y * TILE_SIZE
          x1 = x0 + TILE_SIZE
          y1 = y0 + TILE_SIZE
          heights = terrain_corners(map.map_id, entry[:cell])
          index = entry[:atlas_index]
          atlas_x = (index % columns) * TILE_SIZE
          atlas_y = (index / columns) * TILE_SIZE
          u0 = (atlas_x + 0.5) / atlas.width.to_f
          u1 = (atlas_x + TILE_SIZE - 0.5) / atlas.width.to_f
          v0 = (atlas_y + 0.5) / atlas.height.to_f
          v1 = (atlas_y + TILE_SIZE - 0.5) / atlas.height.to_f
          alpha_top = distance_alpha(y0, camera_ground_y)
          alpha_bottom = distance_alpha(y1, camera_ground_y)
          cell = entry[:cell]
          north_cell = MakerStudio.terrain_cell(map.map_id, x, y - 1)
          east_cell = MakerStudio.terrain_cell(map.map_id, x + 1, y)
          south_cell = MakerStudio.terrain_cell(map.map_id, x, y + 1)
          west_cell = MakerStudio.terrain_cell(map.map_id, x - 1, y)
          exposed = {
            :north => terrain_edge_exposed?(map.map_id, cell, north_cell, :north),
            :east => terrain_edge_exposed?(map.map_id, cell, east_cell, :east),
            :south => terrain_edge_exposed?(map.map_id, cell, south_cell, :south),
            :west => terrain_edge_exposed?(map.map_id, cell, west_cell, :west)
          }
          insets = terrain_top_insets(cell, exposed)
          append_terrain_top(vertices, indices, map.map_id, cell, x0, y0,
                             u0, v0, u1, v1, camera_ground_y, insets)

          if MakerStudio.terrain_overpass?(cell)
            thickness = [MakerStudio::TERRAIN_OVERPASS_THICKNESS,
                         MakerStudio.terrain_height_step(map.map_id) * 0.5].min
            underside = heights.map { |height| [height - thickness, 0.0].max }
            mesh_quad(vertices, indices, [
              [x0, y1, underside[2], u0, v1, 0.48, alpha_bottom],
              [x1, y1, underside[3], u1, v1, 0.48, alpha_bottom],
              [x1, y0, underside[1], u1, v0, 0.48, alpha_top],
              [x0, y0, underside[0], u0, v0, 0.48, alpha_top]
            ])
          end

          append_sampled_terrain_edge(vertices, indices, map.map_id, cell, north_cell,
                                      :north, x0, y0, [u0, v0], [u1, v0], camera_ground_y,
                                      insets[:west] > 0.001, insets[:east] > 0.001)
          append_sampled_terrain_edge(vertices, indices, map.map_id, cell, east_cell,
                                      :east, x0, y0, [u1, v0], [u1, v1], camera_ground_y,
                                      insets[:north] > 0.001, insets[:south] > 0.001)
          append_sampled_terrain_edge(vertices, indices, map.map_id, cell, south_cell,
                                      :south, x0, y0, [u0, v1], [u1, v1], camera_ground_y,
                                      insets[:west] > 0.001, insets[:east] > 0.001)
          append_sampled_terrain_edge(vertices, indices, map.map_id, cell, west_cell,
                                      :west, x0, y0, [u0, v0], [u0, v1], camera_ground_y,
                                      insets[:north] > 0.001, insets[:south] > 0.001)
        end
        [vertices, indices]
      end

      def shadow_texture(state)
        texture = state[:shadow_texture]
        return texture if texture && !texture.disposed?
        size = 32
        bytes = []
        size.times do |y|
          progress = y.to_f / (size - 1)
          size.times do |x|
            horizontal = ((x.to_f / (size - 1)) * 2.0 - 1.0).abs
            edge = [1.0 - horizontal * horizontal, 0.0].max
            alpha = (255.0 * edge * ((1.0 - progress) ** 0.65)).round
            bytes.concat([0, 0, 0, alpha])
          end
        end
        texture = Bitmap.new(size, size)
        texture.raw_data = bytes.pack("C*")
        state[:shadow_texture] = texture
      end

      def character_shadow_record(character, bounds = nil)
        return nil unless character && character.map == $game_map
        return nil if character.transparent
        return nil if character.character_name.to_s.empty? && character.tile_id.to_i <= 0
        x = character.real_x.to_f / Game_Map::X_SUBPIXELS +
            character.width.to_f * TILE_SIZE / 2.0
        y = character.real_y.to_f / Game_Map::Y_SUBPIXELS + TILE_SIZE
        if bounds
          return nil if x < bounds[0] - TILE_SIZE || x > bounds[2] + TILE_SIZE ||
                        y < bounds[1] - TILE_SIZE || y > bounds[3] + TILE_SIZE
        end
        elevation = character_elevation(character)
        cell = defined?(MakerStudio) ? MakerStudio.terrain_cell(
          $game_map.map_id, (x / TILE_SIZE).floor, (y / TILE_SIZE).floor
        ) : nil
        on_overpass = defined?(MakerStudio) && MakerStudio.terrain_overpass?(cell) &&
                      MakerStudio.terrain_character_surface(character, cell) == :top
        { :x => x, :y => y, :width => [character.width.to_f * 14.0, 10.0].max,
          :length => 25.0, :elevation => elevation, :character => character,
          :on_overpass => on_overpass }
      end

      def shadow_record_visible?(record, bounds)
        margin_x = [record[:width].to_f, TILE_SIZE.to_f].max
        margin_y = [record[:length].to_f, TILE_SIZE.to_f].max
        record[:x] >= bounds[0] - margin_x && record[:x] <= bounds[2] + margin_x &&
          record[:y] >= bounds[1] - margin_y && record[:y] <= bounds[3] + margin_y
      end

      def model_shadow_records(bounds, state = nil)
        scene = MakerStudioPseudo3D.scene($game_map.map_id)
        return [] unless scene
        revision = (MakerStudio.terrain_revision($game_map.map_id) rescue nil)
        cache_key = [$game_map.map_id, scene.object_id, revision]
        result = state && state[:model_shadow_records_key] == cache_key ?
                   state[:model_shadow_records] : nil
        unless result
          result = []
          (scene["instances"] || []).each do |instance|
            next if instance["visible"] == false
            model = MakerStudioPseudo3D.asset(instance["assetId"])
            next unless model
            scale = [[(instance["scale"] || 1).to_f, 0.1].max, 8.0].min
            width_tiles = [(instance["footprintW"] || model["footprintW"] || 1).to_f, 1.0].max
            depth_tiles = [(instance["footprintD"] || model["footprintD"] || 1).to_f, 1.0].max
            x = instance["x"].to_f + width_tiles * TILE_SIZE / 2.0
            y = instance["y"].to_f + depth_tiles * TILE_SIZE / 2.0
            elevation = if defined?(MakerStudio) && MakerStudio.respond_to?(:terrain_height_at_pixel)
                          MakerStudio.terrain_height_at_pixel($game_map.map_id, x, y)
                        else
                          0.0
                        end
            cell = defined?(MakerStudio) ? MakerStudio.terrain_cell(
              $game_map.map_id, (x / TILE_SIZE).floor, (y / TILE_SIZE).floor
            ) : nil
            result << { :x => x, :y => y,
                        :width => [[width_tiles * TILE_SIZE * scale * 0.7, 12.0].max, 128.0].min,
                        :length => [[(model["pixelHeight"] || DEFAULT_HEIGHT).to_f * scale * 0.45,
                                     depth_tiles * TILE_SIZE * 0.7].max, 160.0].min,
                        :elevation => elevation, :instance => instance,
                        :on_overpass => defined?(MakerStudio) && MakerStudio.terrain_overpass?(cell) }
          end
          if state
            state[:model_shadow_records_key] = cache_key
            state[:model_shadow_records] = result
          end
        end
        result.select { |record| shadow_record_visible?(record, bounds) }
      end

      def shadow_records(bounds, state = nil)
        return [] unless lighting_enabled?
        result = []
        characters = [$game_player]
        characters.concat($game_map.events.values)
        cache = state ? (state[:character_shadow_cache] ||= {}) : {}
        active = {}
        revision = (MakerStudio.terrain_revision($game_map.map_id) rescue nil)
        characters.each do |character|
          next unless character
          surface = character.instance_variable_get(:@maker_studio_terrain_surface)
          key = [character.map&.map_id, character.real_x, character.real_y,
                 character.width, character.transparent, character.character_name,
                 character.tile_id, surface, revision]
          cached = cache[character.object_id]
          if cached && cached[:key] == key
            record = cached[:record]
          else
            record = character_shadow_record(character)
            cache[character.object_id] = { :key => key, :record => record }
          end
          active[character.object_id] = true
          result << record if record && shadow_record_visible?(record, bounds)
        end
        cache.delete_if { |owner_id, _entry| !active[owner_id] } if state
        result.concat(model_shadow_records(bounds, state))
      end

      def shadow_signature(records)
        records.map do |record|
          owner = record[:character] || record[:instance]
          surface = record[:character]&.instance_variable_get(:@maker_studio_terrain_surface)
          [owner.object_id, (record[:x] * 16).round, (record[:y] * 16).round,
           (record[:elevation] * 16).round, record[:width].round, record[:length].round, surface]
        end
      end

      def shadow_height_at(x, y, record)
        character = record[:character]
        if character && defined?(MakerStudioPseudo3D::ModelWalking) &&
           MakerStudioPseudo3D::ModelWalking.state(character)&.fetch(:id, nil)
          return MakerStudioPseudo3D::ModelWalking.elevation(character, x, y) + 0.2
        end
        if defined?(MakerStudio) && MakerStudio.respond_to?(:terrain_height_at_pixel)
          MakerStudio.terrain_height_at_pixel($game_map.map_id, x, y, character) + 0.2
        else
          record[:elevation].to_f + 0.2
        end
      end

      def build_shadow_mesh(records)
        vertices = []
        indices = []
        angle = MapSettings.value(:PSEUDO3D_SHADOW_ANGLE_DEGREES).to_f * Math::PI / 180.0
        direction_x = Math.cos(angle)
        direction_y = Math.sin(angle)
        perpendicular_x = -direction_y
        perpendicular_y = direction_x
        length_scale = [MapSettings.value(:PSEUDO3D_SHADOW_LENGTH).to_f, 0.0].max
        records.each do |record|
          width = record[:width].to_f
          length = record[:length].to_f * length_scale
          next if width <= 0.0 || length <= 0.0
          start_x = record[:x].to_f - direction_x * width * 0.18
          start_y = record[:y].to_f - direction_y * width * 0.18
          end_x = start_x + direction_x * length
          end_y = start_y + direction_y * length
          half_width = width * 0.5
          points = [
            [start_x - perpendicular_x * half_width, start_y - perpendicular_y * half_width],
            [start_x + perpendicular_x * half_width, start_y + perpendicular_y * half_width],
            [end_x + perpendicular_x * half_width * 0.55, end_y + perpendicular_y * half_width * 0.55],
            [end_x - perpendicular_x * half_width * 0.55, end_y - perpendicular_y * half_width * 0.55]
          ]
          heights = points.map { |point| shadow_height_at(point[0], point[1], record) }
          mesh_quad(vertices, indices, [
            [points[0][0], points[0][1], heights[0], 0.0, 0.0, 1.0, 1.0],
            [points[1][0], points[1][1], heights[1], 1.0, 0.0, 1.0, 1.0],
            [points[2][0], points[2][1], heights[2], 1.0, 1.0, 1.0, 1.0],
            [points[3][0], points[3][1], heights[3], 0.0, 1.0, 1.0, 1.0]
          ])
        end
        [vertices, indices]
      end

      def terrain_foreground_entry?(entry)
        return true if MakerStudio.terrain_overpass?(entry[:cell])
        return false unless $game_player && entry[:map].equal?($game_map)
        return false if terrain_corners(entry[:map].map_id, entry[:cell]).max <= 0.001
        player_foot_y = $game_player.real_y.to_f / Game_Map::Y_SUBPIXELS + TILE_SIZE
        entry_north_y = entry[:origin_y] + entry[:y] * TILE_SIZE
        entry_north_y >= player_foot_y - 0.5
      end

      def fog_records(state)
        return [] unless defined?(MakerStudio) && MakerStudio.respond_to?(:ground_fog_layers)
        result = []
        state[:records].each do |map, origin_x, origin_y|
          MakerStudio.ground_fog_layers(map.map_id).each do |layer|
            next if layer[:sprite].opacity.to_i <= 0
            result << layer.merge(:map => map, :origin_x => origin_x, :origin_y => origin_y)
          end
          # RPG Maker's native tileset fog is a separate AnimatedPlane at
          # z=3000, not a Maker Studio fogLayers entry. Route it through the
          # same terrain projection path so cloud graphics become ground
          # shadows instead of a screen-space overlay above characters.
          spriteset = if $scene && $scene.respond_to?(:spriteset)
                        $scene.spriteset(map.map_id)
                      end
          native_fog = spriteset&.instance_variable_get(:@fog)
          if native_fog && !native_fog.disposed? && native_fog.bitmap &&
             !native_fog.bitmap.disposed? && native_fog.opacity.to_i > 0
            result << {
              :sprite => native_fog, :map => map,
              :origin_x => origin_x, :origin_y => origin_y,
              :scroll_x => map.fog_ox.to_f, :scroll_y => map.fog_oy.to_f,
              :follow => false, :parallax => 1.0, :native_fog => true
            }
          end
        end
        result
      end

      def fog_signature(layers)
        layers.map do |layer|
          sprite = layer[:sprite]
          tone = sprite.tone
          [layer[:map].map_id, sprite.bitmap.object_id, sprite.opacity,
           sprite.blend_type, sprite.zoom_x, layer[:scroll_x], layer[:scroll_y],
           layer[:follow], layer[:parallax],
           tone.red, tone.green, tone.blue, tone.gray]
        end
      end

      def build_fog_mesh(layer, bounds, camera, display_y)
        map = layer[:map]
        origin_x = layer[:origin_x]
        origin_y = layer[:origin_y]
        min_x = [((bounds[0] - origin_x) / TILE_SIZE).floor, 0].max
        min_y = [((bounds[1] - origin_y) / TILE_SIZE).floor, 0].max
        max_x = [((bounds[2] - origin_x) / TILE_SIZE).ceil, map.width - 1].min
        max_y = [((bounds[3] - origin_y) / TILE_SIZE).ceil, map.height - 1].min
        return [[], []] if min_x > max_x || min_y > max_y
        sprite = layer[:sprite]
        bitmap = sprite.bitmap
        zoom = [sprite.zoom_x.to_f, 0.1].max
        parallax = layer[:follow] ? 0.0 : layer[:parallax].to_f
        map_display_x = map.display_x.to_f / Game_Map::X_SUBPIXELS
        map_display_y = map.display_y.to_f / Game_Map::Y_SUBPIXELS
        offset_x = -map_display_x * (1.0 - parallax) + layer[:scroll_x]
        offset_y = -map_display_y * (1.0 - parallax) + layer[:scroll_y]
        texture_width = bitmap.width * zoom
        texture_height = bitmap.height * zoom
        camera_ground_y = display_y + camera[:center_y] + camera[:back]
        vertices = []
        indices = []
        (min_y..max_y).each do |tile_y|
          (min_x..max_x).each do |tile_x|
            local_x0 = tile_x * TILE_SIZE
            local_y0 = tile_y * TILE_SIZE
            local_x1 = local_x0 + TILE_SIZE
            local_y1 = local_y0 + TILE_SIZE
            world_x0 = origin_x + local_x0
            world_y0 = origin_y + local_y0
            world_x1 = world_x0 + TILE_SIZE
            world_y1 = world_y0 + TILE_SIZE
            heights = terrain_corners(map.map_id, MakerStudio.terrain_cell(map.map_id, tile_x, tile_y))
            u0 = (local_x0 + offset_x) / texture_width
            u1 = (local_x1 + offset_x) / texture_width
            v0 = (local_y0 + offset_y) / texture_height
            v1 = (local_y1 + offset_y) / texture_height
            alpha_top = distance_alpha(world_y0, camera_ground_y)
            alpha_bottom = distance_alpha(world_y1, camera_ground_y)
            mesh_quad(vertices, indices, [
              [world_x0, world_y0, heights[0], u0, v0, 1.0, alpha_top],
              [world_x1, world_y0, heights[1], u1, v0, 1.0, alpha_top],
              [world_x1, world_y1, heights[3], u1, v1, 1.0, alpha_bottom],
              [world_x0, world_y1, heights[2], u0, v1, 1.0, alpha_bottom]
            ])
          end
        end
        [vertices, indices]
      end

      def refresh_scene(renderer, state)
        records = scene_maps
        signature = scene_signature(records)
        if state[:signature] != signature
          clear_chunks(state)
          state[:signature] = signature
        end
        # Origins still need to track camera/map scrolling for projection, but
        # changing them must not invalidate static chunk and terrain caches.
        state[:records] = records
        current_animation = animation_signature(renderer)
        if state[:animation_signature] != current_animation
          state[:animation_signature] = current_animation
          state[:render_key] = nil
          state[:ground_atlas_animation_dirty] = true
          state[:ground_atlas_animation_cursor] = 0
        end
      end

      def render_ground(renderer, state)
        camera = camera_values
        display_x = $game_map.display_x.to_f / Game_Map::X_SUBPIXELS
        display_y = $game_map.display_y.to_f / Game_Map::Y_SUBPIXELS
        bounds = visible_world_bounds(camera, display_x, display_y)
        tone = renderer.instance_variable_get(:@tone)
        color = renderer.instance_variable_get(:@color)
        if render_ground_shader(
          renderer, state, camera, display_x, display_y, bounds
        )
          output = state[:sprite]
          output.tone = lighting_tone(tone) || tone || Tone.new(0, 0, 0, 0)
          output.color = color if color
          output.visible = true
          atlas = state[:ground_atlas]
          terrain_entries = visible_terrain_entries(state, bounds)
          render_terrain_shaders(
            state, camera, display_x, display_y, atlas, terrain_entries, tone, color
          )
          terrain_data = state[:terrain_data_texture]
          terrain_atlas = state[:terrain_render_atlas]
          terrain_data = nil unless terrain_atlas && !terrain_atlas.disposed? &&
                                    state[:terrain_data_origin] == state[:terrain_render_origin] &&
                                    state[:terrain_data_atlas_key] == state[:terrain_render_atlas_key] &&
                                    state[:terrain_data_key]
          # Do not discard whole authored cells from the z=0 ground pass. The
          # programmatic cliff side samples the same atlas, so a tile-wide mask
          # also punches holes through its visible edge geometry.
          render_shadow_shaders(
            renderer, state,
            MapSettings.value(:CAMERA_DYNAMIC_SHADOWS) ? shadow_records(bounds, state) : [],
            camera, display_x, display_y
          )
          render_fog_shaders(
            renderer, state, fog_records(state), camera, display_x, display_y,
            terrain_atlas, terrain_data
          ) if terrain_data
          return
        end

        # prepare_ground_atlas intentionally builds one chunk per frame. Do
        # not fall through to the legacy scanline path while that first atlas
        # is pending, because chunk_for there would synchronously build the
        # entire frustum and reintroduce the scene-entry hitch. Keep the last
        # target visible until the pending atlas is ready.
        if state[:ground_atlas_pending]
          output = state[:sprite]
          unless state[:ground_atlas] && !state[:ground_atlas].disposed?
            # The first map update has no prior projected frame to preserve.
            # apply_tilemap leaves the native tiles visible during this brief
            # construction window.
            output.visible = false
            return
          end
          output.bitmap = state[:target] unless output.bitmap == state[:target]
          output.src_rect.set(0, 0, state[:target].width, state[:target].height)
          output.x = 0
          output.y = 0
          output.zoom_x = 1.0
          output.zoom_y = 1.0
          output.visible = true
          return
        end

        state[:terrain_sprite].visible = false if state[:terrain_sprite]
        state[:overpass_sprite].visible = false if state[:overpass_sprite]
        state[:foreground_sprite].visible = false if state[:foreground_sprite]
        (state[:fog_overlays] || {}).each_value { |entry| entry[:sprite].visible = false }
        (state[:shadow_overlays] || {}).each_value { |entry| entry[:sprite].visible = false }
        render_key = [display_x, display_y, @camera_values.object_id,
                      state[:signature], state[:animation_signature]]
        if state[:render_key] != render_key
          target = state[:target]
          target.clear
          state[:overpass_target].clear
          state[:foreground_target].clear
          dest_rect = state[:dest_rect]
          source_rect = state[:source_rect]
          camera[:rows].each do |row|
            screen_y, strip_height, relative_y, relative_left, relative_right, opacity = row
            world_y = display_y + relative_y
            left_world = display_x + relative_left
            right_world = display_x + relative_right
            span = right_world - left_world
            next if span <= 0.001
            chunk_y = world_y.floor.div(CHUNK_SIZE)
            first_chunk = left_world.floor.div(CHUNK_SIZE)
            last_chunk = (right_world.ceil - 1).div(CHUNK_SIZE)
            (first_chunk..last_chunk).each do |chunk_x|
              bitmap = chunk_for(renderer, state, chunk_x, chunk_y)
              next unless bitmap
              chunk_left = chunk_x * CHUNK_SIZE
              segment_left = [left_world, chunk_left].max
              segment_right = [right_world, chunk_left + CHUNK_SIZE].min
              next if segment_right <= segment_left
              dest_left = ((segment_left - left_world) * Graphics.width / span).floor
              dest_right = ((segment_right - left_world) * Graphics.width / span).ceil
              source_left = (segment_left - chunk_left).floor
              source_right = (segment_right - chunk_left).ceil
              source_y = world_y.floor - chunk_y * CHUNK_SIZE
              source_left = [[source_left, 0].max, CHUNK_SIZE - 1].min
              source_right = [[source_right, source_left + 1].max, CHUNK_SIZE].min
              dest_rect.set(dest_left, screen_y, [dest_right - dest_left, 1].max, strip_height)
              source_rect.set(source_left, source_y, source_right - source_left, 1)
              target.stretch_blt(dest_rect, bitmap, source_rect, opacity)
            end
          end
          state[:render_key] = render_key
        end
        output = state[:sprite]
        output.bitmap = state[:target] unless output.bitmap == state[:target]
        output.src_rect.set(0, 0, state[:target].width, state[:target].height)
        output.x = 0
        output.y = 0
        output.zoom_x = 1.0
        output.zoom_y = 1.0
        output.tone = lighting_tone(tone) || tone || Tone.new(0, 0, 0, 0)
        output.color = color if color
        output.visible = true
      end

      def apply_tilemap(renderer)
        if suspended?
          restore_tilemap(renderer)
          dispose_state(renderer)
          return
        end
        unless enabled? && $game_map
          dispose_state(renderer) unless enabled?
          return
        end
        state = ensure_state(renderer)
        state[:rendered_view_valid] = false
        refresh_scene(renderer, state)
        render_ground(renderer, state)

        # The first projected atlas is intentionally assembled across several
        # frames. Keep the stock tile sprites visible until that first atlas is
        # complete so a newly entered map never shows an empty ground while
        # preserving the small per-frame construction budget.
        initial_atlas_pending = state[:ground_atlas_pending] &&
                                (!state[:ground_atlas] || state[:ground_atlas].disposed?)
        return if initial_atlas_pending

        if renderer.native_tiles_required?
        hidden = []
        each_native_tile(renderer) do |sprite|
          next unless sprite.visible && sprite.bitmap
          if !defined?(StandingTiles) && standing_tile?(sprite)
            apply_standing_sprite(sprite)
            apply_lighting_tone(sprite)
          else
            sprite.visible = false
            hidden << sprite
          end
        end
        (renderer.instance_variable_get(:@ext_visible) || []).each do |sprite|
          next unless sprite.visible && sprite.bitmap
          if !defined?(StandingTiles) && standing_tile?(sprite)
            apply_standing_sprite(sprite)
            apply_lighting_tone(sprite)
          else
            sprite.visible = false
            hidden << sprite
          end
        end
        (renderer.instance_variable_get(:@shadow_sprites) || []).each do |sprite|
          next unless sprite && !sprite.disposed? && sprite.visible
          sprite.visible = false
          hidden << sprite
        end
        renderer.instance_variable_set(:@maker_p3d_hidden, hidden)
        end
        if defined?(StandingTiles)
          state[:standing_tiles] ||= StandingTiles.new(renderer)
          state[:standing_tiles].update(state)
        end
        view = state[:rendered_view] ||= []
        view[0], view[1], view[2], view[3] = $game_map, $game_map.display_x,
                                           $game_map.display_y, camera_values
        state[:rendered_view_valid] = true
      end

      def each_companion_sprite(character_sprite)
        helper = character_sprite.instance_variable_get(:@reflection)
        sprite = helper&.instance_variable_get(:@sprite)
        yield sprite, :reflection if sprite
        helper = character_sprite.instance_variable_get(:@surfbase)
        sprite = helper&.instance_variable_get(:@sprite)
        yield sprite, :surfbase if sprite
      end

      def character_elevation(character)
        return 0.0 unless defined?(MakerStudio) && MakerStudio.respond_to?(:terrain_height_at_pixel)
        map = character.map
        return 0.0 unless map
        x = character.real_x.to_f / Game_Map::X_SUBPIXELS + Game_Map::TILE_WIDTH / 2.0
        y = character.real_y.to_f / Game_Map::Y_SUBPIXELS + Game_Map::TILE_HEIGHT / 2.0
        MakerStudio.terrain_height_at_pixel(map.map_id, x, y, character)
      end

      def character_on_overpass_top?(character)
        return false unless defined?(MakerStudio) && character && character.map
        cell = MakerStudio.terrain_cell(character.map.map_id, character.x, character.y)
        MakerStudio.terrain_overpass?(cell) &&
          MakerStudio.terrain_character_surface(character, cell) == :top
      end

      def apply_character_overpass_z(sprite, character)
        sprite.z = OVERPASS_LAYER_Z + 1 if character_on_overpass_top?(character)
      end

      def hide_ground_companion(sprite)
        return unless sprite && !sprite.disposed?
        capture_sprite(sprite)
        sprite.visible = false
      end

      def model_on_overpass_top?(map_id, pixel_x, pixel_y)
        return false unless defined?(MakerStudio)
        cell = MakerStudio.terrain_cell(map_id, (pixel_x / TILE_SIZE).floor,
                                        (pixel_y / TILE_SIZE).floor)
        MakerStudio.terrain_overpass?(cell)
      end
    end
  end
end

class TilemapRenderer
  def native_tiles_required?
    @maker_p3d_native_tiles != false
  end

  alias maker_p3d_camera_update update unless method_defined?(:maker_p3d_camera_update)
  def update
    camera = MakerStudioPseudo3D::Camera
    state = @maker_p3d_mode7
    @maker_p3d_native_tiles = !(camera.enabled? && defined?(MakerStudioPseudo3D::StandingTiles) &&
      state && state[:rendered_view_valid] && camera.ground_shader_active?(state) && !@need_refresh)
    camera.restore_tilemap(self, native_tiles_required?)
    maker_p3d_camera_update
    camera.apply_tilemap(self)
    # A lost shader must recover the 2D/scanline path in this same update.
    unless native_tiles_required? || camera.ground_shader_active?(@maker_p3d_mode7)
      @maker_p3d_native_tiles = true
      camera.restore_tilemap(self)
      maker_p3d_camera_update
      camera.apply_tilemap(self)
    end
    @autotiles.changed = false
  end

  alias maker_p3d_camera_dispose dispose unless method_defined?(:maker_p3d_camera_dispose)
  def dispose
    MakerStudioPseudo3D::Camera.restore_tilemap(self)
    MakerStudioPseudo3D::Camera.dispose_state(self)
    maker_p3d_camera_dispose
  end
end

class Sprite_Character

  if method_defined?(:setShadows)
    alias maker_p3d_camera_set_shadows setShadows unless method_defined?(:maker_p3d_camera_set_shadows)
    def setShadows(map, shadows)
      if MakerStudioPseudo3D::Camera.enabled? && !MakerStudioPseudo3D::MapSettings.value(:CAMERA_DYNAMIC_SHADOWS)
        clearShadows if respond_to?(:clearShadows)
        return
      end
      maker_p3d_camera_set_shadows(map, shadows)
    end
  end

  module MakerP3DCameraUpdate
  def update
    camera = MakerStudioPseudo3D::Camera
    camera.restore_sprite(self)
    camera.each_companion_sprite(self) { |sprite| camera.restore_sprite(sprite) }
    # Essentials intentionally skips the complete sprite update for distant
    # events. Returning here also prevents shadow/sway aliases later in the
    # chain from doing work for every event on a dense map.
    if @character.is_a?(Game_Event) && !@character.should_update?
      return
    end
    super
    sort_y = @character.screen_y_ground
    if TilemapRenderer::ZOOM_Y != 1
      sort_y = ((sort_y - (Graphics.height / 2)) * TilemapRenderer::ZOOM_Y) +
               (Graphics.height / 2)
    end
    elevation = camera.character_elevation(@character)
    camera.apply_standing_sprite(self, sort_y, 0.0, elevation)
    camera.apply_character_overpass_z(self, @character)
    camera.apply_lighting_tone(self)
    fog_x = @character.real_x.to_f / Game_Map::X_SUBPIXELS +
            @character.width.to_f * Game_Map::TILE_WIDTH / 2.0
    fog_y = @character.real_y.to_f / Game_Map::Y_SUBPIXELS +
            Game_Map::TILE_HEIGHT / 2.0
    if @character.map
      fog_width = [@character.width.to_f * Game_Map::TILE_WIDTH, 1.0].max
      fog_depth = [@character.height.to_f * Game_Map::TILE_HEIGHT, 1.0].max
      camera.apply_object_fog(self, @character.map.map_id, fog_x, fog_y,
                              fog_width, fog_depth)
    end
    on_overpass_top = camera.character_on_overpass_top?(@character)
    camera.each_companion_sprite(self) do |sprite, kind|
      if kind == :reflection || on_overpass_top
        camera.hide_ground_companion(sprite)
      else
        camera.apply_standing_sprite(sprite, nil, 0.0, elevation)
        camera.apply_lighting_tone(sprite)
      end
    end
  end


  end
  prepend MakerP3DCameraUpdate unless ancestors.include?(MakerP3DCameraUpdate)

  alias maker_p3d_camera_character_dispose dispose unless method_defined?(:maker_p3d_camera_character_dispose)
  def dispose
    MakerStudioPseudo3D::Camera.clear_object_fog(self)
    maker_p3d_camera_character_dispose
  end
end

if defined?(Sprite_Shadow)
  class Sprite_Shadow
    alias maker_p3d_camera_shadow_update update unless method_defined?(:maker_p3d_camera_shadow_update)
    def update
      if MakerStudioPseudo3D::Camera.enabled? && !MakerStudioPseudo3D::MapSettings.value(:CAMERA_DYNAMIC_SHADOWS)
        self.visible = false
        self.opacity = 0
        return
      end
      maker_p3d_camera_shadow_update
    end
  end
end

# The stock tileset fog belongs to Spriteset_Map rather than Maker Studio's
# fog-layer cache. Keep its bitmap/scroll lifecycle intact, but suppress the
# topmost Plane while Camera.fog_records renders the terrain-projected copy.
class Spriteset_Map
  alias maker_p3d_camera_native_fog_update update unless method_defined?(:maker_p3d_camera_native_fog_update)
  def update
    maker_p3d_camera_native_fog_update
    panorama = instance_variable_get(:@panorama)
    if panorama && !panorama.disposed?
      if MakerStudioPseudo3D::Camera.hide_panorama?
        @maker_p3d_panorama_visible = panorama.visible unless instance_variable_defined?(:@maker_p3d_panorama_visible)
        panorama.visible = false
      elsif instance_variable_defined?(:@maker_p3d_panorama_visible)
        panorama.visible = @maker_p3d_panorama_visible
        remove_instance_variable(:@maker_p3d_panorama_visible)
      end
    end
    fog = instance_variable_get(:@fog)
    if fog && !fog.disposed?
      projected = MakerStudioPseudo3D::Camera.enabled? &&
                  MakerStudioPseudo3D::Camera.projection_shader_available? &&
                  fog.bitmap && !fog.bitmap.disposed?
      fog.visible = !projected
    end
  end
end

if defined?(MakerStudio) && MakerStudio.respond_to?(:update_fog_sprites)
  module MakerStudioPseudo3D
    module PanoramaVisibility
      def update_fog_sprites(*args)
        super
        return unless Camera.hide_panorama?
        # Maker Studio recreates normal viewport visibility on every update,
        # so returning to 2D restores it without rewriting saved map layers.
        (@fog_viewports_cache || {}).each_value do |groups|
          viewport = groups['panorama']
          viewport.visible = false if viewport && !viewport.disposed?
        end
      end
    end
  end
  MakerStudio.singleton_class.prepend(MakerStudioPseudo3D::PanoramaVisibility)
end

if $DEBUG
  MenuHandlers.add(:debug_menu, :pseudo3d_camera_toggle, {
    "name"        => _INTL("Toggle Pseudo 3D Camera"),
    "parent"      => :maker_studio_menu,
    "description" => _INTL("Enable or disable the JoiPlay-compatible Mode 7 camera."),
    "effect"      => proc {
      enabled = MakerStudioPseudo3D::Camera.toggle
      $scene.map_renderer.refresh if $scene.respond_to?(:map_renderer) && $scene.map_renderer
      pbMessage(enabled ? _INTL("Pseudo 3D camera enabled") : _INTL("Pseudo 3D camera disabled"))
    }
  })
end
