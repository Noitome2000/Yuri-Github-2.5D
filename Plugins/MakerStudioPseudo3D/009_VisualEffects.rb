# frozen_string_literal: true

# GPU-only animation: no bitmap regeneration or Model3D rebake on light/wind ticks.
module MakerStudioPseudo3D
  module VisualEffects
    MAX_LIGHTS = 8
    # Every object shader receives the same indexed names. Reuse the strings
    # while continuing to submit changing positions/brightness each frame.
    LIGHT_UNIFORMS = %w[fxLightPosition fxLightColor fxConePosition fxConeColor
                       fxConeShape fxConeDirection fxConeBillboard].to_h do |name|
      [name, Array.new(MAX_LIGHTS) { |index| "#{name}[#{index}]".freeze }.freeze]
    end.freeze
    class << self
      attr_reader :lights, :settings, :time

      def numeric(value, fallback, min, max)
        return fallback if value.nil?
        n = Float(value) rescue fallback
        n = fallback unless n.finite?
        [[n, min].max, max].min
      end

      def light_config(raw)
        r = raw.is_a?(Hash) ? raw : {}
        color = r['color'].to_s
        color = '#ffe0a0' unless color =~ /\A#[0-9a-f]{6}\z/i
        config = { 'enabled' => r['enabled'] == true,
          'type' => r['type'].to_s.downcase == 'street' ? 'street' : 'point',
          'coneAngle' => numeric(r['coneAngle'], 50.0, 10.0, 140.0),
          'softness' => numeric(r['softness'], 0.35, 0.01, 1.0),
          'beam' => numeric(r['beam'], 0.22, 0.0, 1.0),
          'rgb' => [1, 3, 5].map { |i| color[i, 2].to_i(16) / 255.0 },
          'radius' => numeric(r['radius'], 128.0, 8.0, 640.0),
          'height' => numeric(r['height'], 48.0, 0.0, 512.0),
          'offsetX' => numeric(r['offsetX'], 0.0, -256.0, 256.0),
          'offsetY' => numeric(r['offsetY'], 0.0, -256.0, 256.0),
          'offsetZ' => numeric(r['offsetZ'], 0.0, -256.0, 256.0),
          'tilt' => numeric(r['tilt'], 0.0, -75.0, 75.0),
          'heading' => numeric(r['heading'], 0.0, -360.0, 360.0),
          'intensity' => numeric(r['intensity'], 0.8, 0.0, 3.0),
          'breath' => numeric(r['breath'], 0.08, 0.0, 0.5),
          'period' => numeric(r['period'], 3.5, 0.5, 30.0) }
        if config['type'] == 'street'
          angle = config['coneAngle'] * Math::PI / 360.0
          config['cone_outer'] = Math.cos(angle)
          config['cone_inner'] = Math.cos(angle * (1.0-config['softness']))
          config['cone_tangent'] = Math.tan(angle)
          tilt = config['tilt'] * Math::PI / 180.0
          heading = config['heading'] * Math::PI / 180.0
          config['direction'] = [Math.sin(heading)*Math.sin(tilt),
                                 Math.cos(heading)*Math.sin(tilt), -Math.cos(tilt)]
        end
        config
      end

      # Read only the active page; a page change automatically invalidates tags.
      def event_options(event)
        list = event.respond_to?(:list) ? event.list : nil
        return {} unless list
        cache = event.instance_variable_get(:@p3d_fx_comments)
        return cache[1] if cache && cache[0].equal?(list)
        text = list.select { |c| c.code == 108 || c.code == 408 }.map { |c| c.parameters[0].to_s }.join("\n")
        wind = text.match(/<P3D_WIND(?:\s+strength\s*=\s*([\d.]+))?\s*>/i)
        options = { 'wind' => !!wind, 'wind_strength' => wind ? numeric(wind[1], 1.0, 0.5, 4.0) : 0.0 }
        if (match = text.match(/<P3D_LIGHT\b([^>]*)>/i))
          raw = { 'enabled' => true }
          match[1].scan(/(color|radius|height|intensity|breath|period)\s*=\s*(#[0-9a-f]{6}|[+\-]?[\d.]+)/i) { |k, v| raw[k.downcase] = v }
          match[1].scan(/\b(type|coneAngle|softness|beam)\s*=\s*([a-z]+|[+\-]?[\d.]+)/i) { |k, v| raw[k.downcase == 'coneangle' ? 'coneAngle' : k.downcase] = v.downcase }
          match[1].scan(/\b(offsetX|offsetY|offsetZ|tilt|heading)\s*=\s*([+\-]?[\d.]+)/i) do |k, v|
            key = k.downcase
            key = 'offset' + key[-1].upcase if key.start_with?('offset')
            raw[key] = v
          end
          options['light'] = light_config(raw)
        end
        event.instance_variable_set(:@p3d_fx_comments, [list, options])
        options
      end

      def maps
        defined?($map_factory) && $map_factory ? $map_factory.maps : [$game_map].compact
      end

      def world_offset(map)
        [($game_map.display_x.to_f - map.display_x.to_f) / Game_Map::X_SUBPIXELS,
         ($game_map.display_y.to_f - map.display_y.to_f) / Game_Map::Y_SUBPIXELS]
      end

      def elevation(map, x, y)
        return 0.0 unless defined?(MakerStudio) && MakerStudio.respond_to?(:terrain_height_at_pixel)
        MakerStudio.terrain_height_at_pixel(map.map_id, x, y).to_f
      end

      def prepare
        return if @frame == Graphics.frame_count && @map.equal?($game_map)
        @frame, @map = Graphics.frame_count, $game_map
        @time = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        authored = ($game_map && MakerStudioPseudo3D.scene($game_map.map_id) || {})['effects']
        @settings = MapSettings.effects(MapSettings.current_map_id, authored)
        @lights = []
        @cone_lights = nil
        @point_lights = @lights
        @light_stamp = (@light_stamp || 0) + 1
        @ambient = numeric(@settings['ambient'], 1.0, 0.1, 1.5)
        unless Camera.enabled? && $game_map
          clear_post
          clear_beams
          return
        end
        if lighting?
          # Discover sources at 10 Hz. Positions/breathing still update every frame.
          map_key = maps.map { |m| [m.object_id, m.map_id] }
          if @source_key != map_key || !@scan_at || @time - @scan_at >= 0.1
            @source_key, @scan_at, @sources = map_key, @time, []
            maps.each do |map|
              scene = MakerStudioPseudo3D.scene(map.map_id) || {}
              (scene['instances'] || []).each do |i|
                next if i['visible'] == false || i['opacity'] == 0
                # Most map instances are not lights. Do not normalize their
                # optional settings (or allocate arrays) during every scan.
                next unless i['light'].is_a?(Hash) && i['light']['enabled'] == true
                config = light_config(i['light'])
                next unless config['enabled']
                asset = config['type'] == 'street' ? MakerStudioPseudo3D.asset(i['assetId']) : nil
                config['model_anchor'] = asset && asset['type'] == 'model'
                @sources << [map, i, config, false]
              end
              map.events.each_value do |event|
                next if event.instance_variable_get(:@erased)
                config = event_options(event)['light']
                @sources << [map, event, config, true] if config
              end
            end
          end
          dx = $game_map.display_x.to_f / Game_Map::X_SUBPIXELS
          dy = $game_map.display_y.to_f / Game_Map::Y_SUBPIXELS
          (@sources || []).each do |map, source, config, event|
            next if event && (source.instance_variable_get(:@erased) || !event_options(source)['light'])
            config = event_options(source)['light'] if event
            street = config['type'] == 'street'
            x = event ? source.real_x.to_f / Game_Map::X_SUBPIXELS + TILE_SIZE / 2.0 : source['x'].to_f + (source['footprintW'] || 1).to_f * TILE_SIZE / 2.0
            y = event ? source.real_y.to_f / Game_Map::Y_SUBPIXELS + TILE_SIZE / 2.0 : source['y'].to_f + (source['footprintD'] || 1).to_f * TILE_SIZE * (config['model_anchor'] ? 0.5 : 1.0)
            if street && event
              # Match Sprite_Character's actual foot, including graphic offsets
              # and its pixel rounding. Legacy point-light anchors stay intact.
              x = source.screen_x + map.display_x.to_f / Game_Map::X_SUBPIXELS if source.respond_to?(:screen_x)
              y = if source.respond_to?(:screen_y)
                    source.screen_y + map.display_y.to_f / Game_Map::Y_SUBPIXELS
                  else
                    y + TILE_SIZE / 2.0
                  end
            end
            base_height = if street && event && source.respond_to?(:map)
                            Camera.character_elevation(source)
                          else
                            elevation(map, x, y)
                          end
            base_height += source['elevation'].to_f.clamp(-2048,2048) unless event
            z = base_height + [config['height'] + config['offsetZ'], 0.0].max
            x += config['offsetX']; y += config['offsetY']
            offset = world_offset(map)
            x += offset[0]; y += offset[1]
            if street
              projected = project_beam_point(x-dx, y-dy, z, base_height, !config['model_anchor'])
              ground = Camera.project_point(x-dx, y-dy, base_height)
              next unless projected || ground
              samples = [projected, ground].compact
              margin = config['radius'] * samples.map { |p| p[2] }.max * 2.0
              next if samples.all? { |p| p[0] < -margin } || samples.all? { |p| p[0] > Graphics.width + margin } || samples.all? { |p| p[1] < -margin } || samples.all? { |p| p[1] > Graphics.height + margin }
              projected ||= ground
            else
              projected = Camera.project_point(x-dx, y-dy, z)
              next unless projected
              margin = config['radius'] * projected[2] * 2.0
              next if projected[0] < -margin || projected[0] > Graphics.width+margin || projected[1] < -margin || projected[1] > Graphics.height+margin
            end
            phase = (x * 0.037 + y * 0.021) % (Math::PI * 2)
            power = config['intensity'] * (1.0 + config['breath'] * Math.sin(@time * Math::PI * 2 / config['period'] + phase))
            @lights << [[x, y, z, config['radius']], config['rgb'] + [power],
                        (projected[0] - Graphics.width / 2.0)**2 + (projected[1] - Graphics.height / 2.0)**2,
                        config, base_height]
          end
          @lights.sort_by! { |l| l[2] }
          @lights = @lights.first(numeric(@settings['maxLights'], 8, 1, MAX_LIGHTS).to_i)
        end
        if @lights.any? { |l| l[3]['type'] == 'street' }
          @cone_lights, @point_lights = @lights.partition { |l| l[3]['type'] == 'street' }
          update_beams
        else
          @point_lights = @lights
          clear_beams if @beam_bitmap
        end
        update_post
      end

      def lighting?
        Camera.enabled? && @settings && @settings['lighting'] == true
      end

      def configure_light(shader)
        prepare
        # Build and compare one shared payload per scene frame, not once per
        # receiver. Breathing updates colours, without revisiting all positions,
        # cone shapes and directions on hundreds of otherwise static shaders.
        if @light_payload_stamp != @light_stamp
          static = [[:set_float, 'fxLighting', lighting? ? 1.0 : 0.0],
                    [:set_float, 'fxAmbient', @ambient || 1.0],
                    [:set_int, 'fxLightCount', (@point_lights || []).length],
                    [:set_int, 'fxConeCount', (@cone_lights || []).length]]
          colors = []
          (@point_lights || []).each_with_index do |light, index|
            static << [:set_vec4, LIGHT_UNIFORMS['fxLightPosition'][index], *light[0]]
            colors << [:set_vec4, LIGHT_UNIFORMS['fxLightColor'][index], *light[1]]
          end
          (@cone_lights || []).each_with_index do |light, index|
            config = light[3]
            opacity = config['height'] > 0 ? config['beam'] : 0.0
            static << [:set_vec4, LIGHT_UNIFORMS['fxConePosition'][index], *light[0]]
            static << [:set_vec4, LIGHT_UNIFORMS['fxConeShape'][index], config['cone_outer'], config['cone_inner'], light[4], opacity]
            static << [:set_vec3, LIGHT_UNIFORMS['fxConeDirection'][index], *config['direction']]
            static << [:set_float, LIGHT_UNIFORMS['fxConeBillboard'][index], config['model_anchor'] ? 0.0 : 1.0]
            colors << [:set_vec4, LIGHT_UNIFORMS['fxConeColor'][index], *light[1]]
          end
          @light_static_payload = static unless @light_static_payload == static
          @light_color_payload = colors unless @light_color_payload == colors
          @light_payload_stamp = @light_stamp
        end
        unless shader.instance_variable_get(:@p3d_light_static_payload).equal?(@light_static_payload)
          @light_static_payload.each { |call| shader.public_send(*call) }
          shader.instance_variable_set(:@p3d_light_static_payload, @light_static_payload)
        end
        unless shader.instance_variable_get(:@p3d_light_color_payload).equal?(@light_color_payload)
          @light_color_payload.each { |call| shader.public_send(*call) }
          shader.instance_variable_set(:@p3d_light_color_payload, @light_color_payload)
        end
      end

      def object_needed?(sprite)
        prepare
        Camera.enabled? && (lighting? || Camera.terrain_occlusion? || sprite.instance_variable_get(:@p3d_wind) == true)
      end


      def configure_object(sprite, shader, map_id, x, y, rect, surface)
        configure_light(shader)
        map = maps.find { |m| m.map_id == map_id } || $game_map
        return unless map
        if surface && surface[:standing_plane] && !sprite.instance_variable_get(:@p3d_wind)
          # The plane intersection provides X/Y/Z per fragment, independent of
          # source frame, sprite origin and billboard geometry. A windy sprite
          # still uses the general path because wind needs the source frame.
          shader.set_float('standingWorldY', y.to_f +
            ($game_map.display_y.to_f-map.display_y.to_f)/Game_Map::Y_SUBPIXELS)
          shader.set_float('fxBillboardLighting', 0.0)
          shader.set_float('fxWind', 0.0)
          shader.set_vec3('fxConeObjectOffset', 0.0, 0.0, 0.0)
          shader.instance_variable_set(:@p3d_receiver_geometry, nil)
          Camera.configure_world_shader(shader, Camera.camera_values,
            $game_map.display_x.to_f/Game_Map::X_SUBPIXELS,
            $game_map.display_y.to_f/Game_Map::Y_SUBPIXELS)
          Camera.configure_terrain_occlusion(shader)
          return
        end
        r = rect || [sprite.src_rect.x, sprite.src_rect.y, sprite.src_rect.width, sprite.src_rect.height]
        offset = world_offset(map)
        character = sprite.respond_to?(:character) ? sprite.character : nil
        standing_plane = surface && surface[:standing_plane]
        base_height = if standing_plane
                        surface[:height_min].to_f
                      else
                        character ? Camera.character_elevation(character) : elevation(map, x, y)
                      end
        # These values describe the receiver itself. Keep dynamic lighting,
        # wind, texture-presence flags, camera and occlusion outside this cache:
        # apply_object_fog resets useModelPosition before every call.
        geometry = [sprite.bitmap, *r, x, y, *offset, base_height, standing_plane,
                    !!(surface && surface[:position_bitmap]), sprite.instance_variable_get(:@p3d_world_scale)]
        unless shader.instance_variable_get(:@p3d_receiver_geometry) == geometry
          shader.instance_variable_set(:@p3d_receiver_geometry, geometry)
          shader.set_vec4('fxFrame', *r.map(&:to_f))
          shader.set_vec2('fxTextureSize', sprite.bitmap.width.to_f, sprite.bitmap.height.to_f)
          shader.set_float('fxPhase', (x.to_f * 0.037 + y.to_f * 0.021) % 6.283185)
          shader.set_vec3('fxObjectAnchor', x.to_f + offset[0], y.to_f + offset[1], base_height)
          shader.set_float('fxBillboardLighting', standing_plane || (surface && surface[:position_bitmap]) ? 0.0 : 1.0)
          shader.set_float('standingWorldY', y.to_f + offset[1]) if standing_plane
          shader.set_float('fxObjectScale', sprite.instance_variable_get(:@p3d_world_scale) || 1.0)
        end
        windy = Camera.enabled? && sprite.instance_variable_get(:@p3d_wind)
        shader.set_float('fxTime', (@time || 0) % 4096.0) if windy
        shader.set_float('fxWind', windy ? (sprite.instance_variable_get(:@p3d_wind_strength) || 1.0) : 0.0)
        if windy
          # Character sheets often contain large transparent margins. Cache the
          # visible vertical span per frame so roots stay still and crowns move.
          cache = sprite.instance_variable_get(:@p3d_wind_bounds)
          unless cache && cache[0].equal?(sprite.bitmap)
            cache = [sprite.bitmap, {}]
            sprite.instance_variable_set(:@p3d_wind_bounds, cache)
          end
          key = r.map(&:to_i)
          bounds = cache[1][key]
          unless bounds
            left, top, width, height = key
            visible_row = proc { |row| (left...[left+width,sprite.bitmap.width].min).any? { |col| sprite.bitmap.get_pixel(col,top+row).alpha > 0 } }
            first = (0...height).find { |row| visible_row.call(row) } || 0
            last = (first...height).to_a.reverse.find { |row| visible_row.call(row) } || height-1
            bounds = cache[1][key] = [first.to_f, (last+1).to_f]
          end
          shader.set_vec2('fxWindBounds', *bounds)
        end
        if @cone_lights
          cone_x = cone_y = 0.0
          character = sprite.respond_to?(:character) ? sprite.character : nil
          if character && character.respond_to?(:screen_x) && character.respond_to?(:screen_y)
            # Existing point lights retain their receiver coordinates. Only
            # cones use the same bottom-edge foot as the event's drawn sprite.
            cone_x = character.screen_x + map.display_x.to_f / Game_Map::X_SUBPIXELS - x.to_f
            cone_y = character.screen_y + map.display_y.to_f / Game_Map::Y_SUBPIXELS - y.to_f
          end
          shader.set_vec3('fxConeObjectOffset', cone_x, cone_y, 0.0)
        end
        position = surface && surface[:position_bitmap]
        if position && !position.disposed?
          shader.set_bitmap('modelPositionTexture', position)
          shader.set_float('useModelPosition', 1.0)
          shader.set_vec2('modelPositionSize', position.width.to_f, position.height.to_f)
          shader.set_float('modelHeightMin', surface[:height_min].to_f)
          shader.set_float('modelHeightSpan', surface[:height_span].to_f)
        end
        Camera.configure_world_shader(shader, Camera.camera_values,
          $game_map.display_x.to_f / Game_Map::X_SUBPIXELS,
          $game_map.display_y.to_f / Game_Map::Y_SUBPIXELS)
        # A standing tile uses an arbitrary projected quad; its x/y/zoom do
        # not describe the visible bounds or depth. The shader intersects its
        # real world plane for both lighting and terrain occlusion.
        Camera.configure_terrain_occlusion(shader, standing_plane ? nil : sprite)
      end

      # One clipped GPU quad per visible street light; stable bitmap/shader
      # ownership, no pixel loops and no model rebakes as the camera moves.
      # Billboard height points along camera-up, exactly like the upright
      # sprite. Keep the ground plane unchanged so its footprint stays planted.
      def project_beam_point(x, y, z, base, billboard)
        if billboard
          camera = Camera.camera_values
          h = z-base
          x -= camera[:sin_yaw] * camera[:sin_pitch] * h
          y -= camera[:cos_yaw] * camera[:sin_pitch] * h
          z = base + camera[:cos_pitch] * h
        end
        Camera.project_point(x, y, z)
      end

      def update_beams
        selected = (@cone_lights || []).select { |l| l[3]['beam'] > 0 && l[3]['height'] > 0 && l[1][3] > 0 }
        if !lighting? || selected.empty?
          clear_beams
          return
        end
        return if @beam_failed
        viewport = Spriteset_Map.viewport
        clear_beams if @beam_viewport && !@beam_viewport.equal?(viewport)
        @beam_viewport = viewport
        @beams ||= []
        @beam_bitmap ||= Bitmap.new(1, 1)
        @beam_bitmap.fill_rect(0, 0, 1, 1, Color.new(255, 255, 255)) if @beams.empty?
        while @beams.length > selected.length
          sprite, shader = @beams.pop
          sprite.shader = nil; sprite.dispose; shader.dispose
        end
        dx = $game_map.display_x.to_f / Game_Map::X_SUBPIXELS
        dy = $game_map.display_y.to_f / Game_Map::Y_SUBPIXELS
        selected.each_with_index do |light, index|
          unless @beams[index]
            shader = Camera.create_shader('Plugins/MakerStudioPseudo3D/Shaders/street_beam.frag', 'street light beam')
            unless shader
              clear_beams; @beam_failed = true
              return
            end
            sprite = Sprite.new(viewport)
            sprite.bitmap = @beam_bitmap; sprite.shader = shader; sprite.blend_type = 1
            @beams[index] = [sprite, shader]
          end
          sprite, shader = @beams[index]
          position, color, _priority, config, base = light
          x, y, z, range = position
          depth = [z, range].min
          radius = config['tilt'].abs > 0.001 ? range : [depth * config['cone_tangent'], range].min
          points = [[x, y, z]]
          # A box around the truncated cone is conservative at every camera angle.
          [-radius, radius].each { |ox| [-radius, radius].each { |oy| [z + (config['tilt'].abs > 0.001 ? range : 0), z-depth].each { |h| points << [x+ox, y+oy, h] } } }
          billboard = !config['model_anchor']
          projected = points.map { |p| project_beam_point(p[0]-dx, p[1]-dy, p[2], base, billboard) }
          if projected.any?(&:nil?)
            left, top, right, bottom = 0, 0, Graphics.width, Graphics.height
          else
            left = [projected.map { |p| p[0] }.min.floor-1, 0].max
            top = [projected.map { |p| p[1] }.min.floor-1, 0].max
            right = [projected.map { |p| p[0] }.max.ceil+1, Graphics.width].min
            bottom = [projected.map { |p| p[1] }.max.ceil+1, Graphics.height].min
          end
          sprite.visible = right > left && bottom > top
          next unless sprite.visible
          sprite.x, sprite.y = left, top
          sprite.zoom_x, sprite.zoom_y = right-left, bottom-top
          # Draw the background volume above terrain/fog, below objects. Models
          # reconstruct only the volume in front of their actual surface in
          # object_fog.frag; a foot-based sort cannot represent a tall building.
          sprite.z = -60
          Camera.configure_world_shader(shader, Camera.camera_values, dx, dy)
          shader.set_vec4('beamPosition', *position)
          shader.set_vec4('beamColor', *color)
          shader.set_vec4('beamShape', config['cone_outer'], config['cone_inner'], base, config['beam'])
          shader.set_float('beamBillboard', billboard ? 1.0 : 0.0)
          shader.set_vec3('beamDirection', *config['direction'])
          Camera.configure_terrain_occlusion(shader)
        end
      end

      def clear_beams
        (@beams || []).each do |sprite, shader|
          sprite.shader = nil unless sprite.disposed?
          sprite.dispose unless sprite.disposed?
          shader.dispose unless shader.disposed?
        end
        @beam_bitmap.dispose if @beam_bitmap && !@beam_bitmap.disposed?
        @beams = []; @beam_bitmap = @beam_viewport = nil
      end

      def refresh_beam_terrain
        # prepare runs before the tilemap can atomically swap its height atlas.
        # Rebind afterward so no beam keeps a retired/disposed terrain texture.
        (@beams || []).each { |_sprite, shader| Camera.configure_terrain_occlusion(shader) }
      end

      def update_post
        viewport = Spriteset_Map.viewport
        preset = (@settings || {})['preset']
        unless Camera.enabled? && ['cartoon', 'hd2d'].include?(preset) && viewport.respond_to?(:shader=)
          clear_post
          return
        end
        return if @post_failed || (viewport.shader && !viewport.shader.equal?(@post))
        @post ||= Camera.create_shader('Plugins/MakerStudioPseudo3D/Shaders/scene_post.frag', 'scene post')
        unless @post
          @post_failed = true
          return
        end
        @post_viewport = viewport
        viewport.shader = @post unless viewport.shader.equal?(@post)
        @post.set_int('fxPreset', preset == 'cartoon' ? 1 : 2)
        @post.set_vec2('fxResolution', Graphics.width.to_f, Graphics.height.to_f)
        @post.set_float('fxStrength', numeric(@settings['strength'], 0.65, 0.0, 1.0))
        @post.set_float('fxBloom', numeric(@settings['bloom'], 0.12, 0.0, 0.5))
        @post.set_float('fxDof', numeric(@settings['dof'], 0.3, 0.0, 1.0))
      end

      def clear_post
        if @post_viewport && !@post_viewport.disposed? && @post_viewport.shader.equal?(@post)
          @post_viewport.shader = nil
        end
        @post.dispose if @post && !@post.disposed?
        @post = @post_viewport = nil
      end

      def reset
        clear_post
        clear_beams
        @frame = @scan_at = @source_key = @sources = @map = nil
        @lights = []; @point_lights = []; @cone_lights = nil
        @post_failed = @beam_failed = false
      end
    end
  end

  module EffectCameraHooks
    def lighting_tone(tone = nil)
      # Dynamic lighting already applies the authored ambient multiplier.
      # Keep event/day-night tones, without the legacy fixed ambient subtraction.
      return tone if VisualEffects.lighting?
      super
    end
    def apply_tilemap(renderer)
      VisualEffects.prepare
      super
    end
    def render_ground_shader(*args)
      result = super
      VisualEffects.configure_light(args[1][:ground_shader]) if result && args[1][:ground_shader]
      result
    end
    def configure_projection_shader(shader, *args)
      super
      VisualEffects.configure_light(shader)
    end
    def render_terrain_shaders(*args)
      result = super
      VisualEffects.refresh_beam_terrain
      result
    end
    def object_fog_available?(map_id = nil)
      VisualEffects.prepare
      super || VisualEffects.lighting?
    end
    def suspend
      super
      VisualEffects.clear_post
      VisualEffects.clear_beams
    end
    def toggle
      result = super
      VisualEffects.reset
      result
    end
  end
  Camera.singleton_class.prepend(EffectCameraHooks)

  module EffectCharacterHooks
    def update
      options = VisualEffects.event_options(@character)
      @p3d_wind = options['wind'] == true
      @p3d_wind_strength = options['wind_strength']
      @p3d_world_scale = 1.0
      super
    end
  end

  module EffectRendererHooks
    def dispose
      super
      # The scene viewport is shared; a connected-map disposal can safely
      # release the post pass, which the next live map update reinstates.
      VisualEffects.reset
    end
  end
  Renderer.prepend(EffectRendererHooks)
end
Sprite_Character.prepend(MakerStudioPseudo3D::EffectCharacterHooks)
