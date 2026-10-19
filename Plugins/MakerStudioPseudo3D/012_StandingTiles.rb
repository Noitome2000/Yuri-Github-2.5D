module MakerStudioPseudo3D
  # Native/extended standing tiles have their own world-space index. The stock
  # TilemapRenderer pool covers a flat screen, not the perspective frustum.
  class StandingTiles
    SIZE = 32
    BUCKET = 256
    attr_reader :records, :visuals

    def self.standing?(priority, props)
      props ||= {}
      return props['standing'] unless props['standing'].nil?
      return props['isStanding'] unless props['isStanding'].nil?
      priority.to_i > 0
    end

    # Same algorithm as map-snapshot.js::standingAnchors. Overlapping scenery
    # can move part of a column to another layer. Join exact source neighbours
    # across layers only when their ground anchor is unambiguous.
    def self.assign_anchors(records)
      records.group_by { |r| [r[:map].map_id, r[:x]] }.each_value do |column|
        rows = column.group_by { |r| r[:y] }
        column.sort_by { |r| -r[:y] }.each do |r|
          below = (rows[r[:y] + 1] || []).select do |other|
            r[:source] == other[:source] &&
              r[:source_column] == other[:source_column] &&
              r[:source_row] + 1 == other[:source_row]
          end
          same_layer = below.select { |other| other[:layer] == r[:layer] }
          candidates = (same_layer.empty? ? below : same_layer).map { |other| other[:bottom] }.uniq
          r[:bottom] = candidates.length == 1 ? candidates.first : r[:y]
        end
      end
      records
    end

    def self.local_corners(height, props)
      props ||= {}
      angle = props['rotation'].to_f * Math::PI / 180.0
      c, s = Math.cos(angle), Math.sin(angle)
      flip_x = props['flip_h'] || props['flipH']
      flip_y = props['flip_v'] || props['flipV']
      [[0,0],[SIZE,0],[SIZE,height],[0,height]].map do |x,y|
        x -= SIZE/2.0
        y -= height/2.0
        x = -x if flip_x
        y = -y if flip_y
        [SIZE/2.0+x*c-y*s, height/2.0+x*s+y*c]
      end
    end

    def initialize(renderer)
      @renderer = renderer
      @visuals = {}
      @records = []
    end

    def invalidate
      @signature = nil
    end

    def dispose
      @visuals.each_value { |s| dispose_visual(s) }
      @visuals.clear
      @records.clear
      @buckets = {}
      @projection_key = nil
      @ground_cache = {}
      @ground_signature = nil
    end

    def dispose_visual(sprite)
      Camera.clear_object_fog(sprite)
      sprite.bitmap = nil
      sprite.dispose unless sprite.disposed?
    end

    def add_record(map, layer, x, y, tile_id, props, extended = nil)
      special = props && (props['autotile_name'] || props['tileset_id'])
      return if tile_id < 48 && !special
      priority = MakerStudio.resolve_band_priority(map, tile_id, props)
      return unless self.class.standing?(priority, props)
      ts_id = (props && props['tileset_id']) || map.tileset_id
      ts = $data_tilesets[ts_id.to_i]
      bitmap = ts && @renderer.tilesets[ts.tileset_name]
      wraps = @renderer.tilesets.instance_variable_get(:@bitmap_wraps) || {}
      columns = bitmap && !wraps[ts.tileset_name] ? [bitmap.width / SIZE, 1].max : 8
      auto = tile_id < 384 || (props && props['autotile_name'])
      @records << {map:map, layer:layer, x:x, y:y, tile_id:tile_id,
        props:props, extended:extended, priority:priority,
        source:auto ? [:auto,x,y] : [:tileset,ts_id.to_i],
        source_column:(tile_id-384)%columns, source_row:(tile_id-384)/columns,
        height:[((props || {})['pixelHeight'] || SIZE).to_f, SIZE].max}
    end

    def rebuild(state)
      dispose
      state[:records].each do |map, _ox, _oy|
        3.times do |layer|
          map.width.times do |x|
            map.height.times do |y|
              entry = MakerStudio.native_props_at(map.map_id, map.width, layer, y*map.width+x)
              add_record(map, layer, x, y, map.data[x,y,layer].to_i, entry && entry[0])
            end
          end
        end
        MakerStudio.ext_layers_index_for(map.map_id, map.width).each do |layer|
          layer[:tiles].each do |index, props|
            add_record(map, MakerStudio.unified_layer(layer['id']), index%map.width,
                       index/map.width, props['tile_id'].to_i, props, layer)
          end
        end
      end
      self.class.assign_anchors(@records)
      @reach = SIZE
      @records.each_with_index do |r, id|
        r[:id] = id
        r[:corners] = self.class.local_corners(r[:height], r[:props])
        r[:projected_corners] = Array.new(8, 0.0)
        @reach = [@reach, (r[:bottom]-r[:y])*SIZE+r[:height]].max
        key = [r[:map].map_id, (r[:x]*SIZE/BUCKET).floor, ((r[:bottom]+1)*SIZE/BUCKET).floor]
        (@buckets[key] ||= []) << r
      end
    end

    def bind(r)
      s = TilemapRenderer::TileSprite.new(@renderer.viewport)
      Camera.reset_tile_sprite(s)
      # reset_tile_sprite is also used for blits; actual tile sprites require
      # a 32px source rectangle before set_src_rect assigns its origin.
      s.src_rect.set(0,0,SIZE,SIZE)
      if r[:extended]
        @renderer.bind_ext_pool_sprite(s, r[:map], r[:extended], 0, r[:props], r[:x], r[:y])
      else
        @renderer.refresh_tile_bitmap(s, r[:map], r[:tile_id])
        if r[:props]
          effects = MakerStudio.props_has_visual_effects?(r[:props])
          @renderer.bind_native_prop_tile(s, r[:props], effects, r[:map], r[:tile_id])
        end
      end
      s
    rescue
      s.dispose if s && !s.disposed?
      raise
    end

    def update(state)
      signature = [state[:signature], @renderer.instance_variable_get(:@ext_gen)]
      if @signature != signature
        rebuild(state)
        @signature = signature
      end
      camera = Camera.camera_values
      dx = $game_map.display_x.to_f / Game_Map::X_SUBPIXELS
      dy = $game_map.display_y.to_f / Game_Map::Y_SUBPIXELS
      terrain_key = Camera.terrain_signature(state[:records])
      if @ground_signature != terrain_key
        @ground_cache.clear
        @records.each { |r| r[:ground] = nil }
        @ground_signature = terrain_key
      end
      projection_key = [dx, dy, camera, state[:records].map { |map,ox,oy| [map.map_id,ox,oy] }, terrain_key]
      if @projection_key == projection_key
        update_appearance
        return
      end
      @projection_key = projection_key
      bounds = Camera.visible_world_bounds(camera, dx, dy)
      # Include tall crowns whose feet lie below/outside the ground frustum,
      # including raised terrain. Final rejection uses all projected corners.
      margin = @reach + 256
      wanted = {}
      sin_yaw, cos_yaw = camera.values_at(:sin_yaw, :cos_yaw)
      sin_pitch, cos_pitch = camera.values_at(:sin_pitch, :cos_pitch)
      center_x, center_y = camera.values_at(:center_x, :center_y)
      focal, camera_height, back = camera.values_at(:focal, :height, :back)
      screen_right, screen_bottom = Graphics.width+SIZE, Graphics.height+SIZE
      depth_x, depth_y = -cos_pitch*sin_yaw, sin_pitch
      vertical_x, vertical_y = -sin_pitch*sin_yaw, -cos_pitch
      state[:records].each do |map, ox, oy|
        min_x = ((bounds[0]-ox-margin)/BUCKET).floor
        max_x = ((bounds[2]-ox+margin)/BUCKET).floor
        min_y = ((bounds[1]-oy-margin)/BUCKET).floor
        max_y = ((bounds[3]-oy+margin)/BUCKET).floor
        (min_x..max_x).each do |bx|
          (min_y..max_y).each do |by|
            (@buckets[[map.map_id,bx,by]] || []).each do |r|
              x = r[:x]*SIZE + ox - dx
              y = (r[:bottom]+1)*SIZE + oy - dy
              local_x, local_y = x-center_x, y-center_y-back
              forward = sin_yaw*local_x + cos_yaw*local_y
              lateral = cos_yaw*local_x - sin_yaw*local_y
              foot_forward = forward + sin_yaw*16
              next if -foot_forward > Camera.far_distance + SIZE
              ground = r[:ground]
              if ground.nil?
                ground_key = [map.map_id, r[:x], r[:bottom]]
                ground = @ground_cache[ground_key] ||= MakerStudio.terrain_height_at_pixel(
                  map.map_id, r[:x]*SIZE+16, (r[:bottom]+1)*SIZE-0.001).to_f
                r[:ground] = ground
              end
              z = ground + (r[:bottom]-r[:y])*SIZE
              dz = z+r[:height]-camera_height
              depth_base = -cos_pitch*forward-sin_pitch*dz
              vertical_base = -sin_pitch*forward+cos_pitch*dz
              corners = r[:projected_corners]
              left = top = Float::INFINITY
              right = bottom = -Float::INFINITY
              valid = true
              index = 0
              while index < 4
                cx,cy = r[:corners][index]
                depth = depth_base+depth_x*cx+depth_y*cy
                if depth <= 0.001
                  valid = false
                  break
                end
                scale = focal/depth
                px = center_x+(lateral+cos_yaw*cx)*scale
                py = center_y-(vertical_base+vertical_x*cx+vertical_y*cy)*scale
                corners[index*2] = px
                corners[index*2+1] = py
                left = px if px < left
                right = px if px > right
                top = py if py < top
                bottom = py if py > bottom
                index += 1
              end
              next unless valid
              next if right < -SIZE || left > screen_right ||
                      bottom < -SIZE || top > screen_bottom
              s = (@visuals[r[:id]] ||= bind(r))
              next unless s.bitmap && !s.bitmap.disposed?
              wanted[r[:id]] = true
              if s.respond_to?(:corners=)
                # corners own the geometry; do not mirror the texture a second
                # time after applying the editor's rotation/flip to the plane.
                s.mirror = false
                s.corners = corners
              else
                s.ox = s.oy = 0
                s.x, s.y = left, top
                s.zoom_x = (right-left)/SIZE
                s.zoom_y = (bottom-top)/SIZE
              end
              foot_dz = ground-camera_height
              foot_depth = -cos_pitch*foot_forward-sin_pitch*foot_dz
              foot_y = foot_depth > 0.001 ? center_y-focal*(-sin_pitch*foot_forward+cos_pitch*foot_dz)/foot_depth : 0
              s.z = foot_y.round + 1 + r[:layer]*0.001
              s.visible = true
            end
          end
        end
      end
      (@visuals.keys-wanted.keys).each do |id|
        dispose_visual(@visuals.delete(id))
      end
      update_appearance
    end

    # Geometry is static while the camera is still, but autotile animation,
    # day/night tone, screen colour and drifting clouds must keep updating.
    def update_appearance
      tones = {}
      color = @renderer.color
      @visuals.each do |id, s|
        next unless s.bitmap && !s.bitmap.disposed?
        @renderer.refresh_tile_frame(s, s.ms_src_id || s.tile_id) if s.animated
        light = s.ms_light || 0
        tone = tones[light] ||= Camera.lighting_tone(@renderer.ms_tone_with_light(light))
        s.tone = tone if tone && s.tone != tone
        s.color = color if color && s.color != color
        update_fog(@records[id], s)
      end
    end

    def update_fog(record, sprite)
      # All transformed corners remain on this world-Y plane. Reconstruct it
      # per fragment instead of stretching one footprint over every atlas tile.
      # This also keeps lights/clouds continuous through stacked rows and does
      # not depend on a sprite sheet's animation frame or perspective scaling.
      surface = record[:fog_surface] ||= {standing_plane: true}
      surface[:height_min] = record[:ground].to_f
      Camera.apply_object_fog(sprite, record[:map].map_id,
                              record[:x]*SIZE+SIZE/2.0, (record[:bottom]+1)*SIZE,
                              SIZE, record[:height], nil, nil, surface)
    end
  end

  module StandingTileRefresh
    def refresh
      super
      state = instance_variable_get(:@maker_p3d_mode7)
      state[:standing_tiles].invalidate if state && state[:standing_tiles]
    end
  end
end
TilemapRenderer.prepend(MakerStudioPseudo3D::StandingTileRefresh)
