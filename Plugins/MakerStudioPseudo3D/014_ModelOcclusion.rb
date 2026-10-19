# Visibility uses opaque surfaces, independently of navigation. In particular,
# a leaf card's transparent rectangle must never hide the pot or another model.
module MakerStudioPseudo3D::ModelOcclusion
  class << self
    def clear
      (@maps || {}).each_value { |entry| entry[:texture]&.dispose }
      @maps = {}
      @cutout_assets = {}
      @alpha_masks = {}
      @legacy_assets = {}
    end

    # An alpha leaf card is a billboard even when imported as OBJ. Preserve
    # its native whole-sprite ordering. Solid furniture needs mesh depth.
    def legacy_sort?(instance, asset)
      return false if instance['walkable'] == true
      return true if asset['type'] != 'model' || asset['animation']
      return true if (instance['wind'].nil? ? asset['wind'] : instance['wind'])
      return true if asset['occlusionMode'] == 'anchor'
      return false if asset['occlusionMode'] == 'mesh'
      @legacy_assets ||= {}
      return @legacy_assets[asset.object_id] if @legacy_assets.key?(asset.object_id)
      label = [asset['id'],asset['name'],asset['category'],*(asset['tags'] || [])].join(' ')
      foliage = label.match?(/盆栽|植被|植物|鲜花|树木|灌木|topiary|foliage|plant|flower|tree|thicket|shrub|bush/i)
      # Transparent decals on a TV or doorway do not turn its solid shell
      # into a billboard. opaque_asset clips those faces to their used UVs.
      @legacy_assets[asset.object_id] = foliage
    end

    def participates?(instance, asset)
      asset && asset['type'] == 'model' && instance['visible'] != false &&
        (instance['opacity'] || 255).to_i == 255 && !legacy_sort?(instance,asset)
    end

    def data(map_id)
      @maps ||= {}
      scene = MakerStudioPseudo3D.scene(map_id)
      revision = defined?(MakerStudio) ? MakerStudio.terrain_revision(map_id) : nil
      key = [scene.object_id, scene && scene['revision'], revision]
      cached = @maps[map_id]
      return cached if cached && cached[:key] == key
      cached[:texture]&.dispose if cached
      records = (scene && scene['instances'] || []).filter_map do |instance|
        asset = MakerStudioPseudo3D.asset(instance['assetId'])
        next unless participates?(instance, asset)
        MakerStudioPseudo3D::ModelWalking.build(map_id, instance, opaque_asset(asset))
      end
      @maps[map_id] = { :key => key, :records => records }
    end

    # Cache alpha only, once per texture. Do not retain another RGSS bitmap or
    # scan image pixels in a frame update. UV rectangles merge adjacent rows.
    def alpha_mask(id)
      @alpha_masks ||= {}
      return @alpha_masks[id] if @alpha_masks.key?(id)
      texture = MakerStudioPseudo3D.texture(id)
      path = texture && texture['path']
      return @alpha_masks[id] = nil unless path && File.file?(path)
      bitmap = Bitmap.new(path)
      width, height = bitmap.width, bitmap.height
      raw = bitmap.raw_data
      alpha = String.new(:encoding => Encoding::BINARY)
      (3...raw.bytesize).step(4) { |i| alpha << raw.getbyte(i) }
      @alpha_masks[id] = [width, height, alpha]
    ensure
      bitmap.dispose if bitmap && !bitmap.disposed?
    end

    def clip_uv(polygon, axis, edge, greater)
      result = []
      polygon.each_with_index do |a, i|
        b = polygon[(i + 1) % polygon.length]
        inside_a = greater ? a[axis] >= edge : a[axis] <= edge
        inside_b = greater ? b[axis] >= edge : b[axis] <= edge
        result << a if inside_a
        next if inside_a == inside_b
        ratio = (edge - a[axis]) / (b[axis] - a[axis])
        result << a.each_index.map { |j| a[j] + (b[j] - a[j]) * ratio }
      end
      result
    end

    def opaque_rectangles(mask, uvs)
      width, height, alpha = mask
      xs = uvs.map { |uv| uv[0] * width }
      ys = uvs.map { |uv| (1 - uv[1]) * height }
      x0, x1 = xs.min.floor, xs.max.floor
      y0, y1 = ys.min.floor, ys.max.floor
      rectangles = []; active = {}; all_opaque = true
      (y0..y1).each do |y|
        runs = []; start = nil
        (x0..x1 + 1).each do |x|
          opaque = x <= x1 && alpha.getbyte((y % height) * width + x % width) == 255
          all_opaque = false if x <= x1 && !opaque
          start = x if opaque && start.nil?
          if !opaque && start
            runs << [start, x]; start = nil
          end
        end
        current = {}
        runs.each do |run|
          rect = active.delete(run) || [run[0], y, run[1], y]
          rect[3] = y + 1
          current[run] = rect
        end
        rectangles.concat(active.values); active = current
      end
      rectangles.concat(active.values)
      all_opaque ? nil : rectangles
    end

    def opaque_asset(asset)
      @cutout_assets ||= {}
      return @cutout_assets[asset.object_id] if @cutout_assets.key?(asset.object_id)
      vertices = asset['vertices'].dup
      faces = (asset['faces'] || []).flat_map do |face|
        ids = %w[a b c].map { |key| face[key] }
        uvs = ids.map { |i| (asset['uvs'] || [])[i] }
        mask = alpha_mask(face['texture'])
        next [face] unless mask && uvs.all?
        rects = opaque_rectangles(mask, uvs)
        next [face] unless rects
        polygon = ids.zip(uvs).map { |i, uv| asset['vertices'][i] + [uv[0] * mask[0], (1 - uv[1]) * mask[1]] }
        rects.flat_map do |x0, y0, x1, y1|
          clipped = polygon
          [[3, x0, true], [3, x1, false], [4, y0, true], [4, y1, false]].each do |axis, edge, greater|
            break if clipped.empty?
            clipped = clip_uv(clipped, axis, edge, greater)
          end
          next [] if clipped.length < 3
          base = vertices.length
          vertices.concat(clipped.map { |p| p.first(3) })
          (1...clipped.length - 1).map { |i| face.merge('a' => base, 'b' => base + i, 'c' => base + i + 1) }
        end
      end
      # Keep original vertices, including unused alpha margins: removing them
      # would change NativeRenderer's scale and the authored model origin.
      @cutout_assets[asset.object_id] = asset.merge('vertices' => vertices, 'faces' => faces)
    end

    def texture(map_id)
      entry = data(map_id)
      return entry if entry[:texture] || entry[:records].empty?
      records = entry[:records]
      origin = 3.times.map { |i| records.map { |r| r[:bounds][0][i] }.min - 1 }
      span = 3.times.map { |i| [records.map { |r| r[:bounds][1][i] }.max-origin[i]+1,1].max }
      pixels = []
      pack_number = proc do |n|
        n = n.round.clamp(0, 16_777_215)
        pixels.concat([(n >> 16)&255,(n >> 8)&255,n&255,255])
      end
      pack_vertex = proc do |v|
        3.times { |i| pack_number.call((v[i]-origin[i])/span[i]*16_777_215) }
      end
      offset = records.length*8
      records.each do |r|
        r[:bounds].each { |v| pack_vertex.call(v) }
        pack_number.call(offset)
        pack_number.call(r[:triangles].length)
        offset += r[:triangles].length*9
      end
      records.each { |r| r[:triangles].each { |t| t[:v].each { |v| pack_vertex.call(v) } } }
      width = 256
      height = [(pixels.length/4.0/width).ceil,1].max
      bitmap = Bitmap.new(width,height)
      bitmap.raw_data = pixels.pack('C*').ljust(width*height*4,"\0")
      entry[:texture], entry[:origin], entry[:span] = bitmap, origin, span
      entry
    end

    def configure_occlusion(sprite, shader, map_id, surface = nil)
      character = sprite.respond_to?(:character) ? sprite.character : nil
      model_id = sprite.instance_variable_get(:@p3d_walk_model_id)
      position = surface && surface[:position_bitmap]
      model_receiver = model_id && position && !position.disposed?
      shader.set_int('walkSelfModel', 0)
      anchor_receiver = sprite.instance_variable_get(:@p3d_anchor_depth_scale)
      plane_receiver = surface && surface[:standing_plane]
      shader.set_int('walkStandingReceiver',plane_receiver ? 1 : 0)
      unless (character || model_receiver || anchor_receiver || plane_receiver) && MakerStudioPseudo3D::Camera.enabled?
        shader.set_int('walkModelCount',0)
        return
      end
      entry = texture(map_id)
      shader.set_int('walkModelCount',entry[:records].length)
      return if entry[:records].empty?
      bitmap = entry[:texture]
      shader.set_bitmap('walkGeometry',bitmap)
      shader.set_vec2('walkTextureSize',bitmap.width.to_f,bitmap.height.to_f)
      shader.set_vec3('walkOrigin',*entry[:origin])
      shader.set_vec3('walkSpan',*entry[:span])
      if model_receiver
        index = entry[:records].index { |r| r[:id] == model_id }
        shader.set_int('walkSelfModel', index ? index+1 : 0)
        shader.set_int('walkModelCount', 0) unless index
        return
      end
      camera = MakerStudioPseudo3D::Camera
      original = sprite.instance_variable_get(:@maker_p3d_projection_base)
      scale = original ? original[3].to_f.abs / [sprite.zoom_y.abs,0.0001].max :
        sprite.instance_variable_get(:@p3d_anchor_depth_scale).to_f
      scale = 1.0 unless scale > 0
      shader.set_float('walkCharacterDepth',camera.camera_values[:focal]*scale)
    end
  end
end

module MakerStudioPseudo3D::StaticBatches
  module OcclusionEligibility
    def eligible?(instance, asset)
      return false if MakerStudioPseudo3D::ModelOcclusion.participates?(instance, asset)
      super
    end
  end
  singleton_class.prepend(OcclusionEligibility)
end

module MakerStudioPseudo3D::VisualEffects
  module ModelOcclusionEffects
    def object_needed?(sprite)
      character = sprite.respond_to?(:character) ? sprite.character : nil
      return true if (sprite.instance_variable_get(:@p3d_walk_model_id) ||
        sprite.instance_variable_get(:@p3d_anchor_depth_scale) ||
        sprite.instance_variable_get(:@p3d_standing_depth)) && MakerStudioPseudo3D::Camera.enabled?
      return true if character && character.map && MakerStudioPseudo3D::Camera.enabled? &&
        !MakerStudioPseudo3D::ModelOcclusion.data(character.map.map_id)[:records].empty?
      super
    end

    def configure_object(sprite, shader, map_id, x, y, rect, surface)
      super
      MakerStudioPseudo3D::ModelOcclusion.configure_occlusion(sprite,shader,map_id,surface)
    end
  end
  singleton_class.prepend(ModelOcclusionEffects)
end

# Native standing tiles keep their foot Z, but must receive the same solid
# furniture mask even on maps without lighting, fog or elevated terrain.
module MakerStudioPseudo3D::StandingFurnitureDepth
  def update_fog(record, sprite)
    sprite.instance_variable_set(:@p3d_standing_depth,true)
    super
  end
end
MakerStudioPseudo3D::StandingTiles.prepend(MakerStudioPseudo3D::StandingFurnitureDepth)

module MakerStudioPseudo3D::ModelWalking
  module OcclusionCacheLifecycle
    def clear
      super
      MakerStudioPseudo3D::ModelOcclusion.clear
    end
  end
  class << self
    prepend OcclusionCacheLifecycle
    def texture(map_id)
      MakerStudioPseudo3D::ModelOcclusion.texture(map_id)
    end
    def configure_occlusion(*args)
      MakerStudioPseudo3D::ModelOcclusion.configure_occlusion(*args)
    end
  end
end
