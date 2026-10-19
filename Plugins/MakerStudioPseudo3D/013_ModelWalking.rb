# Model navigation is independent of MakerStudio's terrain overpass state.
# Only plain values are kept on characters; meshes and GPU data stay map-local.
module MakerStudioPseudo3D
  module ModelWalking
    STEP = 4.0
    CLEARANCE = 24.0
    class << self
      def clear
        (@maps || {}).each_value { |v| v[:texture]&.dispose }
        @maps = {}
      end

      def data(map_id)
        @maps ||= {}
        scene = MakerStudioPseudo3D.scene(map_id)
        revision = defined?(MakerStudio) ? MakerStudio.terrain_revision(map_id) : nil
        key = [scene.object_id, scene && scene['revision'], revision]
        cached = @maps[map_id]
        return cached if cached && cached[:key] == key
        cached[:texture]&.dispose if cached
        records = []
        (scene && scene['instances'] || []).each do |instance|
          next unless instance['walkable'] == true && instance['visible'] != false
          asset = MakerStudioPseudo3D.asset(instance['assetId'])
          next unless asset && asset['type'] == 'model'
          record = build(map_id, instance, asset)
          records << record if record
        end
        cells = {}
        records.each do |r|
          lo, hi = r[:bounds]
          (lo[0].div(TILE_SIZE)..hi[0].div(TILE_SIZE)).each do |x|
            (lo[1].div(TILE_SIZE)..hi[1].div(TILE_SIZE)).each do |y|
              (cells[[x, y]] ||= []) << r
            end
          end
        end
        @maps[map_id] = { :key => key, :records => records, :cells => cells }
      end

      def build(map_id, instance, asset)
        # This is the same Ry * Rx * Rz pose, pivot and world unit scale as
        # NativeRenderer.configure_view. Animated platforms use the bind pose.
        static = asset.merge('animation' => nil)
        vertices = NativeRenderer.rotated_vertices(static)
        return nil if vertices.empty?
        pivot = %w[X Y Z].map { |axis| asset["pivot#{axis}"].to_f + asset["meshOffset#{axis}"].to_f }
        scale = NativeRenderer.model_unit_scale(asset) * (instance['scale'] || 1).to_f.clamp(0.1, 8)
        angle = instance['rotation'].to_f * Math::PI / 180
        c, s = Math.cos(angle), Math.sin(angle)
        x = instance['x'].to_f + (instance['footprintW'] || asset['footprintW'] || 1).to_f * TILE_SIZE / 2
        y = instance['y'].to_f + (instance['footprintD'] || asset['footprintD'] || 1).to_f * TILE_SIZE / 2
        base = terrain(map_id, x, y) + instance['elevation'].to_f.clamp(-2048,2048)
        vertices = vertices.map do |v|
          dx, dy, dz = 3.times.map { |i| (v[i] - pivot[i]) * scale }
          [x + dx*c - dz*s, y + dx*s + dz*c, base + dy]
        end
        triangles = (asset['faces'] || []).filter_map do |face|
          points = %w[a b c].map { |k| vertices[face[k].to_i] }
          next if points.any?(&:nil?)
          a, b, d = points
          ux, uy, uz = 3.times.map { |i| b[i]-a[i] }
          vx, vy, vz = 3.times.map { |i| d[i]-a[i] }
          normal = [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx]
          area = Math.sqrt(normal.sum { |n| n*n })
          next if area < 0.00001
          { :v => points, :walk => normal[2].abs / area >= 0.707 }
        end
        return nil if triangles.empty?
        bounds = [3.times.map { |i| vertices.map { |v| v[i] }.min },
                  3.times.map { |i| vertices.map { |v| v[i] }.max }]
        { :id => instance['id'], :triangles => triangles, :bounds => bounds,
          :anchor => [x, y, base], :sort_z => nil }
      end

      def terrain(map_id, x, y, character = nil)
        return 0.0 unless defined?(MakerStudio)
        MakerStudio.terrain_height_at_pixel(map_id, x, y, character).to_f
      end

      def height(triangle, x, y)
        a, b, c = triangle[:v]
        den = (b[1]-c[1])*(a[0]-c[0]) + (c[0]-b[0])*(a[1]-c[1])
        return nil if den.abs < 0.00001
        u = ((b[1]-c[1])*(x-c[0]) + (c[0]-b[0])*(y-c[1])) / den
        v = ((c[1]-a[1])*(x-c[0]) + (a[0]-c[0])*(y-c[1])) / den
        return nil if u < -0.00001 || v < -0.00001 || u+v > 1.00001
        u*a[2] + v*b[2] + (1-u-v)*c[2]
      end

      def records_at(map_id, x, y)
        data(map_id)[:cells][[x.div(TILE_SIZE), y.div(TILE_SIZE)]] || []
      end

      def options(map_id, x, y, character = nil)
        result = [[nil, terrain(map_id, x, y, character)]]
        records_at(map_id, x, y).each do |r|
          hits = r[:triangles].filter_map do |t|
            z = height(t, x, y)
            [z, t[:walk]] if z
          end
          hits.each do |z, walk|
            next unless walk
            # Undersides within a solid deck are not separate floors.
            next if hits.any? { |other, _| other > z+0.1 && other < z+CLEARANCE }
            result << [r[:id], z]
          end
        end
        result.uniq { |id, z| [id, (z*100).round] }
      end

      def state(character)
        value = character.instance_variable_get(:@p3d_support)
        value if value && value[:map] == character.map.map_id &&
          value[:x] == character.x && value[:y] == character.y
      end

      def elevation(character, x = nil, y = nil)
        map_id = character.map.map_id
        x ||= character.real_x.to_f / Game_Map::X_SUBPIXELS + TILE_SIZE/2.0
        y ||= character.real_y.to_f / Game_Map::Y_SUBPIXELS + TILE_SIZE/2.0
        value = state(character)
        return terrain(map_id, x, y, character) unless value
        target = value[:z]
        from = value[:from]
        if from
          distance = Math.hypot(value[:x]*TILE_SIZE+TILE_SIZE/2.0-from[0], value[:y]*TILE_SIZE+TILE_SIZE/2.0-from[1])
          ratio = distance > 0 ? (Math.hypot(x-from[0],y-from[1])/distance).clamp(0,1) : 1
          target = from[2] + (target-from[2])*ratio
        end
        candidates = options(map_id, x, y, character)
        best = candidates.min_by { |id, z| (z-target).abs }
        best && (best[1]-target).abs <= STEP*2 ? best[1] : target
      end

      def relevant?(character, x, y, nx, ny)
        return true if state(character)&.fetch(:id, nil)
        map_id = character.map.map_id
        [[x,y],[nx,ny]].any? { |tx,ty| !records_at(map_id, tx*TILE_SIZE+16,ty*TILE_SIZE+16).empty? }
      end

      def transition(character, x, y, nx, ny)
        map_id = character.map.map_id
        sx, sy = x*TILE_SIZE+16.0, y*TILE_SIZE+16.0
        current = state(character)
        initial = current ? [current[:id], current[:z]] : [nil, terrain(map_id,sx,sy,character)]
        selected = initial
        previous_x, previous_y, previous_z = sx, sy, initial[1]
        # Sample the whole step: a hole or cliff between cell centres blocks it.
        1.upto(16) do |i|
          px, py = sx+(nx-x)*TILE_SIZE*i/16.0, sy+(ny-y)*TILE_SIZE*i/16.0
          candidates = options(map_id,px,py,character).select { |id,z| (z-selected[1]).abs <= STEP }
          candidates.sort_by! { |id,z| [(z-selected[1]).abs, id == selected[0] ? 0 : 1] }
          selected = candidates.find do |id,z|
            # A lower floor needs headroom beneath every solid model face.
            records_at(map_id,px,py).none? do |r|
              r[:triangles].any? do |t|
                h = height(t,px,py)
                # STEP limits the climb between supports; it must not let feet
                # remain inside a low step. Otherwise ground wins over a 4px
                # tread, and the following tread becomes an unreachable jump.
                h && h > z+0.1 && h < z+CLEARANCE
              end
            end
          end
          return nil unless selected
          [4.1,12.0,CLEARANCE-0.1].each do |above|
            a = [previous_x,previous_y,(i == 1 ? initial[1] : previous_z)+above]
            b = [px,py,selected[1]+above]
            return nil if (records_at(map_id,previous_x,previous_y)+records_at(map_id,px,py)).uniq.any? do |r|
              r[:triangles].any? { |t| segment_hit?(a,b,t[:v]) }
            end
          end
          previous_x,previous_y,previous_z = px,py,selected[1]
        end
        { :map => map_id, :x => nx, :y => ny, :id => selected[0], :z => selected[1],
          :source_id => initial[0], :from => [sx,sy,initial[1]] }
      end

      def same_level?(a, b, target_z = nil)
        return true unless a && b && a.map && b.map
        return false unless a.map.map_id == b.map.map_id
        ((target_z || elevation(a))-elevation(b)).abs < CLEARANCE
      end

      def segment_hit?(a,b,vertices)
        cross = proc { |u,v| [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]] }
        dot = proc { |u,v| 3.times.sum { |i| u[i]*v[i] } }
        p0,p1,p2 = vertices
        ray = 3.times.map { |i| b[i]-a[i] }
        e1,e2 = [p1,p2].map { |p| 3.times.map { |i| p[i]-p0[i] } }
        p = cross.call(ray,e2)
        det = dot.call(e1,p).to_f
        return false if det.abs < 0.000001
        t = 3.times.map { |i| a[i]-p0[i] }
        u = dot.call(t,p)/det
        return false if u < 0 || u > 1
        q = cross.call(t,e1)
        v = dot.call(ray,q)/det
        return false if v < 0 || u+v > 1
        distance = dot.call(e2,q)/det
        distance > 0.00001 && distance <= 1.0
      end
    end
  end

  module WalkingCache
    def clear
      ModelWalking.clear
      super
    end
  end
  singleton_class.prepend(WalkingCache)
end

class Game_Character
  module ModelWalkingCharacter
    def passable?(x, y, d, strict = false)
      nav = MakerStudioPseudo3D::ModelWalking
      @p3d_pending_support = nil
      dx, dy = {2=>[0,1],4=>[-1,0],6=>[1,0],8=>[0,-1]}[d]
      return super unless dx
      nx, ny = x+dx, y+dy
      return super unless nav.relevant?(self,x,y,nx,ny)
      return false unless map.valid?(nx,ny)
      return super if @through
      route = nav.transition(self,x,y,nx,ny)
      return false unless route
      # The old terrain overpass transition is deliberately not called here.
      # Underlying ground tiles still enforce water/walls; a model floor owns
      # its own passability and can span impassable ground.
      [[x,y,d,route[:source_id]],[nx,ny,10-d,route[:id]]].each do |tx,ty,dir,support|
        return false if map.pseudo3d_blocked?(tx,ty)
        next if support
        # Generic map passability dispatches players back to playerPassable?,
        # which would run the terrain-only height transition a second time and
        # reject the bank-to-model edge. Keep terrain tags/tile passage checks
        # through the original player entry point instead.
        ground_method = if strict
                          :maker_studio_terrain_passable_strict
                        elsif self == $game_player
                          :maker_studio_terrain_player_passable
                        else
                          :maker_studio_terrain_passable
                        end
        return false unless map.public_send(ground_method,tx,ty,dir,self)
      end
      map.events.each_value do |event|
        next if event == self || event.through || !event.at_coordinate?(nx,ny)
        next unless nav.same_level?(self,event,route[:z])
        return false if self != $game_player || event.character_name != ''
      end
      if self != $game_player && $game_player && $game_player.x == nx && $game_player.y == ny &&
         !$game_player.through && @character_name != '' && nav.same_level?(self,$game_player,route[:z])
        return false
      end
      @p3d_pending_support = route
      true
    end

    def increase_steps
      pending = @p3d_pending_support
      super
      @p3d_support = pending if pending && pending[:x] == x && pending[:y] == y
      @p3d_pending_support = nil
    end

    def moveto(x,y)
      super
      @p3d_support = @p3d_pending_support = nil
    end
  end
end

class Game_Event
  module ModelWalkingEvent
    def start(*args)
      if [0,1,2].include?(@trigger) && $game_player &&
         !MakerStudioPseudo3D::ModelWalking.same_level?(self,$game_player)
        return
      end
      super
    end
  end
end

# Install after every plugin has loaded. Legacy plugins alias passable? while
# loading; an early prepend makes their alias capture this wrapper and recurse
# when our ordinary-ground fallback calls super (notably Pokemon Farming).
# Map setup also runs on loading a save and before its events are constructed.
EventHandlers.add(:on_game_map_setup, :maker_p3d_install_model_walking,
  proc do |_map_id, _map, _tileset|
    Game_Character.prepend(Game_Character::ModelWalkingCharacter) unless
      Game_Character.ancestors.include?(Game_Character::ModelWalkingCharacter)
    Game_Event.prepend(Game_Event::ModelWalkingEvent) unless
      Game_Event.ancestors.include?(Game_Event::ModelWalkingEvent)
  end
)

module MakerStudioPseudo3D::Camera
  module ModelWalkingCamera
    def character_elevation(character)
      return super unless character && character.map
      MakerStudioPseudo3D::ModelWalking.elevation(character)
    end
  end
  singleton_class.prepend(ModelWalkingCamera)
end
