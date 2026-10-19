require 'digest'
require 'fileutils'

module MakerStudioPseudo3D
  # Render-only derived meshes. Original instances still own editing, collision
  # and save data. Cache keys include mesh/material/texture content and poses.
  module StaticBatches
    CACHE = 'Graphics/MakerStudioPseudo3D/BatchCache'
    VERSION = 2
    class << self
      def owner(scene, instance)
        nodes = (scene['groups'] || []) + scene['instances']
        seen = {}
        id = instance['parentId']
        while id && !id.empty? && !seen[id]
          seen[id] = true
          node = nodes.find { |n| n['id'] == id }
          break unless node
          return id if node['group'] && node['batch'] == true
          id = node['parentId']
        end
        nil
      end

      def eligible?(i, a)
        return false if i['walkable'] == true
        %w[model billboard].include?(a['type']) && i['visible'] != false &&
          !a['animation'] &&
          (i['opacity'] || 255).to_i == 255 &&
          !(i['wind'].nil? ? a['wind'] : i['wind']) &&
          !(i['light'].is_a?(Hash) && i['light']['enabled']) &&
          !(a['light'].is_a?(Hash) && a['light']['enabled'])
      end

      def records(scene, records, map_id)
        buckets = {}
        records.each_value do |i, a|
          group = owner(scene, i)
          next unless group && eligible?(i, a)
          x = i['x'].to_f + (i['footprintW'] || a['footprintW'] || 1).to_f * 16
          y = i['y'].to_f + (i['footprintD'] || a['footprintD'] || 1).to_f * (a['type'] == 'billboard' ? 32 : 16)
          h = MakerStudio.respond_to?(:terrain_height_at_pixel) ? MakerStudio.terrain_height_at_pixel(map_id, x, y).to_f : 0.0
          h += i['elevation'].to_f.clamp(-2048,2048)
          # Exact depth/elevation preserve the existing Sprite sort plane.
          next if a['type'] == 'billboard' && !billboard_camera_compatible?
          key = [group, a['type'], (x / 128).floor, y, h]
          (buckets[key] ||= []) << [i, a, x, y, h]
        end
        result = records.dup
        @sources = {}
        @billboard_sources = {}
        buckets.each_value do |members|
          next if members.length < 2
          begin
            pair = members[0][1]['type'] == 'billboard' ? build_billboards(members) : build(members)
            next unless pair
            members.each { |m| result.delete(m[0]['id']) }
            result[pair[0]['id']] = pair
          rescue => error
            # Missing/unsupported input must preserve every original visual.
            Console.echo_error("Pseudo3D batch fallback: #{error.message}") if defined?(Console)
          end
        end
        result
      ensure
        @sources = nil
        @billboard_sources = nil
      end

      def source(asset)
        path = MakerStudioPseudo3D.obj_path(asset)
        return @sources[path] if @sources.key?(path)
        obj = File.binread(path)
        mtl_path = MakerStudioPseudo3D.mtl_path(path)
        mtl = File.exist?(mtl_path) ? File.binread(mtl_path) : ''
        raise 'translucent material' if mtl.lines.any? { |l| l =~ /^\s*d\s+([\d.]+)/ && $1.to_f < 1 || l =~ /^\s*Tr\s+([\d.]+)/ && $1.to_f > 0 || l =~ /^\s*map_d\s/ }
        textures = {}
        mtl.lines.each do |line|
          next unless line =~ /^\s*map_Kd\s+(.+?)\s*$/
          name = $1.strip
          raise 'texture options require independent rendering' if name.start_with?('-')
          textures[name] = File.binread(File.join(File.dirname(path), name))
        end
        @sources[path] = [obj, mtl, textures]
      end

      # A horizontal image strip shares perspective only at one depth. A yaw
      # change restores the originals instead of flattening a diagonal forest.
      def billboard_camera_compatible?
        !Camera.enabled? || (Camera.camera_values[:sin_yaw].abs < 0.000001 &&
                            Camera.camera_values[:cos_yaw] > 0)
      end

      def build_billboards(members)
        parts = members.map do |i, a, x, y, h|
          cached = @billboard_sources && @billboard_sources[a.object_id]
          unless cached
            path = MakerStudioPseudo3D.image_path(a)
            raise 'missing billboard image' unless path && File.file?(path)
            cached = [path, Digest::SHA256.file(path).hexdigest]
            @billboard_sources[a.object_id] = cached if @billboard_sources
          end
          path, image_digest = cached
          iw, ih = a['imageWidth'].to_f, a['imageHeight'].to_f
          raise 'missing billboard dimensions' unless iw > 0 && ih > 0
          height = (a['pixelHeight'] || ih).to_f * [[(i['scale'] || 1).to_f, 0.1].max, 8.0].min
          [path, x, height * iw / ih, height, image_digest]
        end
        left = parts.map { |p| p[1] - p[2] / 2 }.min.floor
        right = parts.map { |p| p[1] + p[2] / 2 }.max.ceil
        height = parts.map { |p| p[3] }.max.ceil
        width = right - left
        return nil if width <= 0 || height <= 0 || width > 512 || height > 768
        id = 'billboard_batch_' + Digest::SHA256.hexdigest(Marshal.dump([VERSION, members, parts]))
        asset = {'id'=>id, 'type'=>'billboard', 'pixelHeight'=>height,
          'imageWidth'=>width*2, 'imageHeight'=>height*2, 'batchParts'=>parts,
          'batchLeft'=>left, 'batchElevation'=>members[0][4],
          'batchMembers'=>members.map { |m| m[0]['id'] }}
        footprint = [width/32.0, 1].max
        instance = {'id'=>id, 'assetId'=>id, 'x'=>left+width/2.0-footprint*16, 'y'=>members[0][3]-32,
          'footprintW'=>footprint, 'footprintD'=>1, 'scale'=>1,
          'rotation'=>0, 'opacity'=>255, 'visible'=>true}
        [instance, asset]
      end

      def billboard_bitmap(asset)
        images = {}
        result = Bitmap.new(asset['imageWidth'], asset['imageHeight'])
        asset['batchParts'].each do |path, x, w, h, _digest|
          source = (images[path] ||= Bitmap.new(path))
          rect = Rect.new(((x-w/2-asset['batchLeft'])*2).round,
                          ((asset['pixelHeight']-h)*2).round,
                          (w*2).round, (h*2).round)
          result.stretch_blt(rect, source, Rect.new(0,0,source.width,source.height))
        end
        result
      rescue
        result.dispose if result && !result.disposed?
        raise
      ensure
        images.each_value { |b| b.dispose unless b.disposed? }
      end

      def build(members)
        fingerprint = members.map { |i,a,x,y,h| [i,a,source(a),x,y,h] }
        digest = Digest::SHA256.hexdigest(Marshal.dump([VERSION, fingerprint]))
        dir = "#{CACHE}/#{digest}"
        center_x = members.sum { |m| m[2] } / members.length
        center_y = members[0][3]
        vertices = []; lines = ['mtllib mesh.mtl']; materials = {}; texture_files = {}
        vertex_offset = uv_offset = normal_offset = 0
        members.each_with_index do |(instance, asset, x, y, _h), part|
          obj, mtl, textures = source(asset)
          material_names = {}
          blocks = {'default'=>['Kd 1 1 1']}
          material_name = 'default'
          mtl.lines.each do |line|
            if line =~ /^\s*newmtl\s+(.+?)\s*$/
              material_name = $1.strip
              blocks[material_name] = []
            elsif line =~ /^\s*map_Kd\s+(.+?)\s*$/
              name = $1.strip
              dest = "#{Digest::SHA256.hexdigest(textures.fetch(name))}#{File.extname(name)}"
              texture_files[dest] = textures[name]
              blocks[material_name] << "map_Kd #{dest}"
            else
              text = line.strip
              blocks[material_name] << text unless text.empty? || text.start_with?('#')
            end
          end
          blocks.each do |name, block|
            body = block.join("\n")
            canonical = "m#{Digest::SHA256.hexdigest(body)}"
            materials[canonical] = "newmtl #{canonical}\n#{body}"
            material_names[name] = canonical
          end
          lines << "usemtl #{material_names['default']}"
          raw = []; normals = []; uvs = []; faces = []; current = 'default'
          obj.lines.each do |line|
            fields = line.strip.split
            case fields.shift
            when 'v' then raw << fields.first(3).map(&:to_f)
            when 'vn' then normals << fields.first(3).map(&:to_f)
            when 'vt' then uvs << fields.first(2).map(&:to_f)
            when 'usemtl' then current = fields.join(' ')
            when 'f'
              counts = [raw.length, uvs.length, normals.length]
              indices = fields.map do |field|
                field.split('/', -1).each_with_index.map do |n, axis|
                  n.empty? ? nil : (n.to_i < 0 ? counts[axis] + n.to_i : n.to_i - 1)
                end
              end
              faces << [current, indices]
            end
          end
          raise 'empty mesh' if raw.empty? || faces.empty?
          offsets = %w[X Y Z].map { |axis| asset["meshOffset#{axis}"].to_f }
          pivot = %w[X Y Z].each_with_index.map { |axis,j| asset["pivot#{axis}"].to_f + offsets[j] }
          posed = NativeRenderer.rotated_vertices(asset.merge('vertices'=>raw.map { |v| 3.times.map { |j| v[j]+offsets[j] } }))
          unit = NativeRenderer.model_unit_scale(asset) * (instance['scale'] || 1).to_f
          r = instance['rotation'].to_f * Math::PI / 180
          c, s = Math.cos(r), Math.sin(r)
          posed.each do |v|
            dx, dz = v[0]-pivot[0], v[2]-pivot[2]
            p = [x-center_x+(dx*c-dz*s)*unit, (v[1]-pivot[1])*unit, y-center_y+(dx*s+dz*c)*unit]
            vertices << p
            lines << "v #{p.join(' ')}"
          end
          uvs.each { |uv| lines << "vt #{uv.join(' ')}" }
          normal_data = asset.merge('vertices'=>normals, 'pivotX'=>0,'pivotY'=>0,'pivotZ'=>0,'meshOffsetX'=>0,'meshOffsetY'=>0,'meshOffsetZ'=>0)
          NativeRenderer.rotated_vertices(normal_data).each { |n| lines << "vn #{n[0]*c-n[2]*s} #{n[1]} #{n[0]*s+n[2]*c}" }
          faces.each do |material, indices|
            lines << "usemtl #{material_names.fetch(material)}"
            lines << 'f ' + indices.map { |tuple| tuple.each_with_index.map { |n,j| n.nil? ? '' : n + [vertex_offset,uv_offset,normal_offset][j] + 1 }.join('/') }.join(' ')
          end
          vertex_offset += raw.length; uv_offset += uvs.length; normal_offset += normals.length
        end
        spans = 3.times.map { |j| values=vertices.map { |v| v[j] }; values.max-values.min }
        return nil if spans[0] > 256 || spans[2] > 128 || spans[1] > 768
        height = spans[1] > 0.001 ? spans[1] : [*spans, 0.001].max
        return nil if height < 1
        FileUtils.mkdir_p(dir)
        texture_files.each { |name, bytes| File.atomic_write("#{dir}/#{name}") { |f| f.write(bytes) } unless File.exist?("#{dir}/#{name}") }
        File.atomic_write("#{dir}/mesh.mtl") { |f| f.write(materials.values.join("\n")) } unless File.exist?("#{dir}/mesh.mtl")
        File.atomic_write("#{dir}/mesh.obj") { |f| f.write(lines.join("\n")) } unless File.exist?("#{dir}/mesh.obj")
        id = "batch_#{digest}"
        fw, fd = [spans[0]/32,1].max, [spans[2]/32,1].max
        asset = {'id'=>id,'type'=>'model','sourceObj'=>"#{dir}/mesh.obj",'vertices'=>vertices,
          'pixelHeight'=>height,'footprintW'=>fw,'footprintD'=>fd,'modular'=>true,'gridUnits'=>0,
          'batchElevation'=>members[0][4], 'batchMembers'=>members.map { |m| m[0]['id'] }}
        instance = {'id'=>id,'assetId'=>id,'x'=>center_x-fw*16,'y'=>center_y-fd*16,
          'footprintW'=>fw,'footprintD'=>fd,'scale'=>1,'rotation'=>0,'opacity'=>255,'visible'=>true}
        [instance,asset]
      end
    end
  end

  module BatchRendererIndex
    def build_index
      super
      @batch_camera_compatible = StaticBatches.billboard_camera_compatible?
      @records = StaticBatches.records(@scene, @records, @map.map_id) if @scene
    end

    def update
      compatible = StaticBatches.billboard_camera_compatible?
      build_index if compatible != @batch_camera_compatible
      super
    end
  end
  Renderer.prepend(BatchRendererIndex)
end
