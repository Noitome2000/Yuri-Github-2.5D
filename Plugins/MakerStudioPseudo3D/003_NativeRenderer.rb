# Model3D backend for mkxp-z-ext. No external renderer is used.
module MakerStudioPseudo3D
  module NativeRenderer
    @models = {}
    @raster_sizes = {}
    # Second Model3D per asset whose shader permanently encodes surface
    # positions. Model3D#shader= recompiles on every assignment, so swapping
    # one model between the color and the position pass would compile shaders
    # every frame; a dedicated instance keeps each program compiled once.
    @position_models = {}
    @position_shader = nil
    @animation_users = {}

    class << self
      POSITION_SHADER_PATH =
        "Plugins/MakerStudioPseudo3D/Shaders/model_position.frag"

      def available?
        defined?(Model3D) && defined?(Bitmap) &&
          Model3D.instance_methods.include?(:render)
      end

      def position_shader
        @position_shader
      end

      def animation_clip(data)
        clip = data['animation']
        return nil unless clip.is_a?(Hash) && clip['version'] == 1 &&
          clip['frames'].is_a?(Array) && clip['frames'].length.between?(2, 180) &&
          clip['fps'].to_f > 0 && clip['fps'].to_f <= 60
        clip
      end

      def animation_frame_index(data, enabled, seconds)
        clip = animation_clip(data)
        return 0 unless clip && enabled
        ([seconds.to_f, 0].max * clip['fps'].to_f).floor % clip['frames'].length
      end

      def retain_animation(data)
        return unless animation_clip(data)
        id = data['id'].to_s
        @animation_users[id] = @animation_users.fetch(id, 0) + 1
      end

      def release_animation(data)
        id = data['id'].to_s
        return unless @animation_users.key?(id)
        @animation_users[id] -= 1
        return if @animation_users[id] > 0
        @animation_users.delete(id)
        # Frames are shared by placements, but released with the last surface.
        prefix = "#{id}/animation/"
        [@models, @position_models].each do |cache|
          cache.keys.select { |key| key.start_with?(prefix) }.each do |key|
            model = cache.delete(key)
            model.dispose if model && model != :failed && !model.disposed?
          end
        end
      end

      def framing_vertices(data)
        clip = animation_clip(data)
        bounds = clip && clip['bounds']
        return data['vertices'] || [] unless bounds.is_a?(Array) && bounds.length == 2
        [0, 1].product([0, 1], [0, 1]).map { |x, y, z| [bounds[x][0], bounds[y][1], bounds[z][2]] }
      end

      def create_surface(data)
        return nil unless available? && data && data["type"] == "model"
        Surface.new(data)
      rescue => e
        Console.echo_error("Pseudo3D Model3D: #{e.message}") if defined?(Console)
        nil
      end

      def prewarm(data)
        model_for(data)
        true
      rescue
        false
      end

      def model_for(data)
        id = data["id"].to_s
        return @models[id] if @models[id] && !@models[id].disposed?
        obj = MakerStudioPseudo3D.obj_path(data)
        raise "missing OBJ #{obj}" unless obj && File.exist?(obj)
        mtl = MakerStudioPseudo3D.mtl_path(obj)
        model = mtl && File.exist?(mtl) ? Model3D.new(obj, mtl) : Model3D.new(obj)

        apply_asset_transform(model, data)
        model.ambient = (AMBIENT_LIGHT rescue 0.38).to_f
        @models[id] = model
      end

      # Model whose bake encodes surface positions (model_position.frag).
      # Created lazily: the position pass only pays off when a fog/cloud layer
      # exists in the scene, which most maps do not have. A :failed sentinel
      # caches load/compile failures so they are retried per asset, not per
      # frame.
      def position_model_for(data)
        id = data["id"].to_s
        cached = @position_models[id]
        return nil if cached == :failed
        return cached if cached && !cached.disposed?
        return nil unless defined?(Shader) &&
                          File.exist?(POSITION_SHADER_PATH)
        obj = MakerStudioPseudo3D.obj_path(data)
        if obj.nil? || !File.exist?(obj)
          @position_models[id] = :failed
          return nil
        end
        begin
          @position_shader ||= Shader.new(POSITION_SHADER_PATH)
        rescue => error
          Console.echo_error(
            "Pseudo3D position bake shader: #{error.message}"
          ) if defined?(Console)
          @position_models[id] = :failed
          return nil
        end
        mtl = MakerStudioPseudo3D.mtl_path(obj)
        model = mtl && File.exist?(mtl) ? Model3D.new(obj, mtl) : Model3D.new(obj)
        # Color and surface-position bakes must use the same default rotation.
        apply_asset_transform(model, data)
        begin
          model.shader = @position_shader
        rescue => error
          Console.echo_error(
            "Pseudo3D position model shader: #{error.message}"
          ) if defined?(Console)
          model.dispose rescue nil
          @position_models[id] = :failed
          return nil
        end
        @position_models[id] = model
      rescue => e
        Console.echo_error("Pseudo3D position model: #{e.message}") if defined?(Console)
        @position_models[id] = :failed
        nil
      end

      def apply_asset_transform(model, data)
        model.scale = 1.0
        %w[X Y Z].each do |axis|
          suffix = axis.downcase
          model.public_send("rotation_#{suffix}=", data["rotation#{axis}"].to_f)
          # Model3D rotates source coordinates before applying meshOffset.
          model.public_send("pivot_#{suffix}=", data["pivot#{axis}"].to_f)
          model.public_send("position_#{suffix}=", data["meshOffset#{axis}"].to_f)
        end
      end

      # Match Model3D's Ry * Rx * Rz matrix and the editor's model-transform.js.
      # Instance yaw remains in the camera; this is the asset's local pose only.
      def rotated_vertices(data)
        vertices = framing_vertices(data)
        angles = %w[X Y Z].map { |axis| data["rotation#{axis}"].to_f * Math::PI / 180.0 }
        return vertices if angles.all? { |angle| angle == 0.0 }
        cx, cy, cz = angles.map { |angle| Math.cos(angle) }
        sx, sy, sz = angles.map { |angle| Math.sin(angle) }
        px, py, pz = %w[X Y Z].map { |axis| data["pivot#{axis}"].to_f + data["meshOffset#{axis}"].to_f }
        vertices.map do |vertex|
          x, y, z = vertex[0].to_f - px, vertex[1].to_f - py, vertex[2].to_f - pz
          zx, zy = x * cz - y * sz, x * sz + y * cz
          xy, xz = zy * cx - z * sx, zy * sx + z * cx
          [px + zx * cy + xz * sy, py + xy, pz - zx * sy + xz * cy]
        end
      end

      def vertex_metrics(data, rotate = true)
        vertices = rotate ? rotated_vertices(data) : framing_vertices(data)
        return nil if vertices.empty?
        xs = vertices.map { |vertex| vertex[0].to_f }
        ys = vertices.map { |vertex| vertex[1].to_f }
        zs = vertices.map { |vertex| vertex[2].to_f }
        # Cliff modules occupy an authored grid cell even when their surface
        # is only a thin strip at one edge. Frame that cell, so neighbouring
        # pieces retain the same world scale and origin instead of stretching
        # every strip to fill an entire tile.
        if data["modular"] == true
          half = [(data["gridUnits"] || 16).to_f, 0.001].max / 2.0
          xs += [-half, half]
          zs += [-half, half]
        end
        {
          center_x: (xs.min + xs.max) / 2.0,
          center_y: (ys.min + ys.max) / 2.0,
          center_z: (zs.min + zs.max) / 2.0,
          min_y: ys.min,
          max_y: ys.max,
          span_x: [xs.max - xs.min, 0.001].max,
          span_y: [ys.max - ys.min, 0.001].max,
          span_z: [zs.max - zs.min, 0.001].max
        }
      end

      # Retained as a fallback for callers without vertex metrics. The renderer
      # uses projected_bbox_rect instead: this scans the whole bitmap in Ruby,
      # which costs ~590k iterations for a 768px bake.
      def opaque_rect(bitmap)
        width = bitmap.width
        height = bitmap.height
        return Rect.new(0, 0, width, height) unless bitmap.respond_to?(:raw_data)
        pixels = bitmap.raw_data
        min_x = width
        min_y = height
        max_x = -1
        max_y = -1
        pixel_index = 0
        byte_index = 3
        while byte_index < pixels.bytesize
          if pixels.getbyte(byte_index).to_i > 4
            x = pixel_index % width
            y = pixel_index / width
            min_x = x if x < min_x
            min_y = y if y < min_y
            max_x = x if x > max_x
            max_y = y if y > max_y
          end
          pixel_index += 1
          byte_index += 4
        end
        return Rect.new(0, 0, width, height) if max_x < min_x || max_y < min_y
        # Only enough margin to keep the faint antialiased rim that the alpha>4
        # test drops. A large margin gets clamped at the bitmap edge, which made
        # the crop asymmetric by a different amount per instance and left dead
        # space inside the quad; the crop is recomputed on every bake, so no
        # extra room is needed to absorb a change of observation angle.
        padding = 2
        left = [min_x - padding, 0].max
        top = [min_y - padding, 0].max
        right = [max_x + padding, width - 1].min
        bottom = [max_y + padding, height - 1].min
        Rect.new(left, top, right - left + 1, bottom - top + 1)
      rescue
        Rect.new(0, 0, bitmap.width, bitmap.height)
      end

      # Bounding-box corners in the bake camera's view space, as
      # [view_x, view_y, w] triples. `w` is the clip-space w that
      # mat4_perspective produces: proj[11] = -1 and view_z = -forward.(p - eye),
      # so w = +forward.(p - eye), positive in front of the camera.
      #
      # Everything the renderer needs about framing comes from these points, so
      # they are computed once and shared by the FOV fit and the crop. No bitmap
      # pixel is ever read.
      def bbox_view_points(metrics, eye, target)
        return nil unless metrics
        forward = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]
        length = Math.sqrt(forward[0] ** 2 + forward[1] ** 2 + forward[2] ** 2)
        return nil if length < 0.0001
        forward = forward.map { |value| value / length }
        # side = forward x up with up = (0, 1, 0), matching mat4_lookAt in
        # model3d.cpp. Getting this sign backwards also flips `upward`, which
        # mirrors the crop.
        side = [-forward[2], 0.0, forward[0]]
        side_length = Math.sqrt(side[0] ** 2 + side[2] ** 2)
        return nil if side_length < 0.0001
        side = side.map { |value| value / side_length }
        # upward = side x forward
        upward = [side[1] * forward[2] - side[2] * forward[1],
                  side[2] * forward[0] - side[0] * forward[2],
                  side[0] * forward[1] - side[1] * forward[0]]
        half_x = metrics[:span_x] / 2.0
        half_y = metrics[:span_y] / 2.0
        half_z = metrics[:span_z] / 2.0
        points = []
        [-1, 1].each do |sx|
          [-1, 1].each do |sy|
            [-1, 1].each do |sz|
              px = metrics[:center_x] + sx * half_x - eye[0]
              py = metrics[:center_y] + sy * half_y - eye[1]
              pz = metrics[:center_z] + sz * half_z - eye[2]
              w = px * forward[0] + py * forward[1] + pz * forward[2]
              return nil if w < 0.0001
              points << [px * side[0] + py * side[1] + pz * side[2],
                         px * upward[0] + py * upward[1] + pz * upward[2],
                         w]
            end
          end
        end
        points
      rescue
        nil
      end

      # NDC of one view-space point. camera_shift_x is fixed at
      # -bake_focal * lateral / distance, and bake_focal = height / (2 tan(fov/2)),
      # so proj[8]'s contribution reduces to scale * off_axis with
      # off_axis = lateral / distance. That removes the fov/shift circularity:
      # the off-axis term can be folded in before the fov is known.
      def point_ndc(point, scale, aspect, off_axis)
        [scale * (point[0] / (aspect * point[2]) + off_axis),
         -(point[1] * scale / point[2])]
      end

      # Smallest fov (degrees) that keeps every corner inside the bitmap.
      # Sizing from the bounding sphere instead underestimates it: the near
      # corners sit `radius` closer than the centre and project up to
      # distance / (distance - radius) larger, which for a tower came to 164% of
      # the half window. The crop then clamped to the whole bitmap and the quad
      # blew up to three times its correct width, pushing the model into the sky.
      def fit_fov(points, aspect, off_axis, margin)
        return nil unless points && !points.empty?
        # |ndc| <= 1 with scale = 1/tan(fov/2) gives tan(fov/2) >= this term.
        extent = 0.0
        points.each do |point|
          term_x = (point[0] / (aspect * point[2]) + off_axis).abs
          term_y = (point[1] / point[2]).abs
          extent = term_x if term_x > extent
          extent = term_y if term_y > extent
        end
        return nil if extent < 1e-6
        fov = 2.0 * Math.atan(extent * margin) * 180.0 / Math::PI
        [[fov, 0.5].max, 170.0].min
      end

      # Screen-space AABB of the projected bounding box.
      #
      # Using the bounding box rather than the pixel-tight silhouette is what
      # keeps neighbouring tiles seamless: the box is the authored footprint,
      # while a tight crop can fall inside it (a fence whose posts are inset)
      # and would shrink the quad below one tile again.
      def projected_bbox_rect(points, fov, aspect, off_axis, width, height)
        return nil unless points && !points.empty?
        scale = 1.0 / Math.tan(fov * Math::PI / 360.0)
        min_x = nil
        max_x = nil
        min_y = nil
        max_y = nil
        points.each do |point|
          ndc = point_ndc(point, scale, aspect, off_axis)
          screen_x = (ndc[0] * 0.5 + 0.5) * width
          screen_y = (ndc[1] * 0.5 + 0.5) * height
          min_x = screen_x if min_x.nil? || screen_x < min_x
          max_x = screen_x if max_x.nil? || screen_x > max_x
          min_y = screen_y if min_y.nil? || screen_y < min_y
          max_y = screen_y if max_y.nil? || screen_y > max_y
        end
        return nil if min_x.nil? || max_x <= min_x || max_y <= min_y
        # One pixel of margin for the antialiased rim.
        left = [(min_x - 1.0).floor, 0].max
        top = [(min_y - 1.0).floor, 0].max
        right = [(max_x + 1.0).ceil, width].min
        bottom = [(max_y + 1.0).ceil, height].min
        return nil if right <= left || bottom <= top
        Rect.new(left, top, right - left, bottom - top)
      rescue
        nil
      end

      # Bake-space metrics of the bbox ground face:
      # [px per model unit on the ground plane, centre x, front edge y].
      #
      # These calibrate the quad. A single factor taken at the bbox centre
      # cannot work: the bake contains perspective, so the near bottom corners
      # project larger than the centre plane and the quad came out 13-25%
      # oversized. The quad is flat, so exactly one depth plane can be correct,
      # and it has to be the ground: that is where the model meets the map and
      # where a mismatch opens seams between neighbouring tiles.
      #
      # The scale comes from the mean ground-face depth rather than from the
      # projected span of that face. Off-axis, the face is seen at an angle and
      # its projected span widens even though its world footprint has not
      # changed; matching the span would then squeeze the model by ~10% as the
      # camera passes it, which reads as breathing.
      #
      # Corner order from bbox_view_points is sx, then sy, then sz, so the four
      # sy = -1 (bottom) corners are indices 0, 1, 4 and 5.
      def ground_face_metrics(points, fov, aspect, off_axis, width, height)
        return nil unless points && points.length == 8
        scale = 1.0 / Math.tan(fov * Math::PI / 360.0)
        indices = [0, 1, 4, 5]
        min_x = nil
        max_x = nil
        max_y = nil
        depth = 0.0
        indices.each do |index|
          point = points[index]
          depth += point[2]
          ndc = point_ndc(point, scale, aspect, off_axis)
          screen_x = (ndc[0] * 0.5 + 0.5) * width
          screen_y = (ndc[1] * 0.5 + 0.5) * height
          min_x = screen_x if min_x.nil? || screen_x < min_x
          max_x = screen_x if max_x.nil? || screen_x > max_x
          max_y = screen_y if max_y.nil? || screen_y > max_y
        end
        depth /= indices.length
        return nil if min_x.nil? || depth < 0.0001
        # bake_focal = height / (2 tan(fov/2)) = height * scale / 2.
        unit_px = height * scale / 2.0 / depth
        return nil if unit_px < 0.0001
        [unit_px, (min_x + max_x) / 2.0, max_y]
      rescue
        nil
      end

      def global_view_angles(rotation)
        direction = if defined?(Camera) && Camera.respond_to?(:model_view_direction)
                      Camera.model_view_direction
                    else
                      radians = (MODEL_CAMERA_AZIMUTH_DEGREES rescue 0.0).to_f *
                                Math::PI / 180.0
                      [Math.sin(radians), Math.cos(radians)]
                    end
        azimuth = Math.atan2(direction[0].to_f, direction[1].to_f) -
                  rotation.to_f * Math::PI / 180.0
        pitch = if defined?(Camera) && Camera.respond_to?(:effective_pitch_degrees)
                  Camera.effective_pitch_degrees.to_f
                else
                  (MapSettings.value(:CAMERA_PITCH_DEGREES) rescue 37.72).to_f
                end
        pitch += (MODEL_PITCH_OFFSET_DEGREES rescue 0.0).to_f
        [azimuth, [[pitch, 1.0].max, 89.0].min * Math::PI / 180.0]
      end

      # Translate a fixed-direction Model3D camera parallel to its image plane.
      # The target moves by the same amount, so lookAt orientation never orbits
      # the model. camera_shift_x recentres the complete off-axis bake.
      def configure_legacy_view(model, metrics, data, rotation, anchor_x, anchor_y,
                         scale, camera, elevation, render_width, render_height,
                         scale_metrics = metrics)
        return global_view_angles(rotation) + [0.0, 1.0, nil] unless camera && metrics
        radians = rotation.to_f * Math::PI / 180.0
        cosine = Math.cos(radians)
        sine = Math.sin(radians)
        footprint_w = [data["footprintW"].to_f, 1.0].max * TILE_SIZE
        footprint_d = [data["footprintD"].to_f, 1.0].max * TILE_SIZE
        x_ppu = footprint_w / scale_metrics[:span_x]
        z_ppu = footprint_d / scale_metrics[:span_z]
        camera_x = camera[:center_x].to_f
        camera_y = camera[:center_y].to_f + camera[:back].to_f
        half_depth = footprint_d * scale.to_f / 2.0
        model_center_x = anchor_x.to_f + half_depth * sine
        model_center_y = anchor_y.to_f - half_depth * cosine
        world_dx = camera_x - model_center_x
        world_dy = camera_y - model_center_y
        local_x = (world_dx * cosine + world_dy * sine) / x_ppu / scale.to_f
        local_z = (-world_dx * sine + world_dy * cosine) / z_ppu / scale.to_f

        authored = (MODEL_CAMERA_AZIMUTH_DEGREES rescue 0.0).to_f *
                   Math::PI / 180.0
        radius = [model.bbox_radius.to_f, 0.001].max
        cx = metrics[:center_x]
        cy = metrics[:center_y]
        cz = metrics[:center_z]
        actual_x = local_x - cx
        actual_z = local_z - cz
        base_azimuth = rotation.to_f * Math::PI / 180.0 + authored
        side_x = Math.cos(base_azimuth)
        side_z = -Math.sin(base_azimuth)
        actual_lateral = actual_x * side_x + actual_z * side_z
        parallax = [[(MODEL_VIEW_PARALLAX rescue 0.35).to_f, 0.0].max, 1.0].min
        pitch_degrees = if defined?(Camera) && Camera.respond_to?(:effective_pitch_degrees)
                          Camera.effective_pitch_degrees.to_f
                        else
                          (MapSettings.value(:CAMERA_PITCH_DEGREES) rescue 37.72).to_f
                        end
        pitch_degrees += (MODEL_PITCH_OFFSET_DEGREES rescue 0.0).to_f
        pitch = [[pitch_degrees, 1.0].max, 89.0].min * Math::PI / 180.0
        # Distance in model units derived from the map camera focal length, not
        # from this mesh's bbox radius. radius * k gave every model its own
        # effective focal length, so a bookshelf, a fence and a tower each
        # leaned by a different amount (3.5deg / 7.9deg / 9.3deg measured).
        # focal is in world px and x_ppu is world px per model unit, so
        # focal / x_ppu is the same eye distance for every asset; dividing by
        # the exaggeration shortens it uniformly to keep some visible lean.
        exaggeration = [(MODEL_PERSPECTIVE_EXAGGERATION rescue 1.0).to_f, 0.05].max
        # scale enlarges the instance in world px without changing the mesh, so
        # it must shorten the eye distance in model units by the same factor.
        distance = camera[:focal].to_f / x_ppu / scale.to_f / exaggeration
        # Floor the distance so the eye stays clear of the mesh. A tall building
        # is ~2x its bbox radius high, so an exaggerated distance could put the
        # eye inside the geometry: the near corners then approach zero depth,
        # the projection diverges, and the model is flung off the quad.
        distance = [distance, radius * 1.8].max
        limit = [(MODEL_VIEW_PARALLAX_MAX_DEGREES rescue 12.0).to_f, 0.0].max *
                Math::PI / 180.0
        max_lateral = Math.tan(limit) * distance
        lateral = [[actual_lateral * parallax, -max_lateral].max, max_lateral].min
        horizontal = Math.cos(pitch) * distance
        backward_x = Math.sin(base_azimuth)
        backward_z = Math.cos(base_azimuth)
        vx = backward_x * horizontal + side_x * lateral
        vy = Math.sin(pitch) * distance
        vz = backward_z * horizontal + side_z * lateral
        eye = [cx + vx, cy + vy, cz + vz]
        target = [cx + side_x * lateral, cy, cz + side_z * lateral]
        # A long eye distance with the map camera's own wide FOV would leave the
        # mesh a few px across in the bake. Fit the FOV to the projected corners
        # instead: distance controls foreshortening, FOV controls framing, and
        # the two stay independent. camera_shift_x recentres the off-axis window,
        # so its NDC contribution reduces to scale * off_axis and can be folded
        # in before the FOV is known.
        aspect = render_width.to_f / render_height.to_f
        off_axis = lateral / distance
        points = bbox_view_points(metrics, eye, target)
        margin = [(MODEL_BAKE_FRAME_MARGIN rescue 1.12).to_f, 1.0].max
        fov = fit_fov(points, aspect, off_axis, margin)
        # Fall back to the bounding sphere only if the corner fit degenerated.
        fov ||= [[2.0 * Math.atan(radius * margin / distance) * 180.0 / Math::PI,
                  1.0].max, 150.0].min

        model.camera_fov = fov
        model.camera_x = eye[0]
        model.camera_y = eye[1]
        model.camera_z = eye[2]
        model.camera_target_x = target[0]
        model.camera_target_y = target[1]
        model.camera_target_z = target[2]
        bake_focal = render_height.to_f /
                     (2.0 * Math.tan(fov * Math::PI / 360.0))
        model.camera_shift_x = -bake_focal * off_axis
        model.camera_shift_y = 0.0
        rect = projected_bbox_rect(points, fov, aspect, off_axis,
                                   render_width, render_height)
        ground = ground_face_metrics(points, fov, aspect, off_axis,
                                     render_width, render_height)
        # Keep the absolute model azimuth in the cache result. The off-axis
        # amount can remain zero while the object turns around its centre, so
        # using only lateral parallax would incorrectly reuse the old bitmap.
        [base_azimuth, Math.atan2(lateral, distance), pitch, distance,
         rect, ground]
      end

      def clear
        @raster_sizes.clear
        @models.each_value { |model| model.dispose unless model.disposed? }
        @models.clear
        @position_models.each_value do |model|
          model.dispose if model && model != :failed && !model.disposed?
        end
        @position_models.clear
      rescue
        @models.clear
        @position_models.clear
      end

      # Bake through the map camera itself, expressed in the asset's local
      # coordinates. Framing changes only the projection window, never the eye
      # distance, pitch or pivot. Adjacent meshes therefore share one projection.
      def configure_view(model, metrics, data, rotation, anchor_x, anchor_y,
                         scale, camera, elevation, width, height, scale_metrics = metrics)
        return configure_legacy_view(model, metrics, data, rotation, anchor_x,
          anchor_y, scale, camera, elevation, width, height, scale_metrics) unless camera && metrics
        unit = model_unit_scale(data) * scale
        pivot = %w[X Y Z].map { |axis| data["pivot#{axis}"].to_f + data["meshOffset#{axis}"].to_f }
        angle = rotation * Math::PI / 180.0
        c, s = Math.cos(angle), Math.sin(angle)
        dx = (camera[:center_x] - anchor_x) / unit
        dz = (camera[:center_y] + camera[:back] - anchor_y) / unit
        eye = [pivot[0] + dx*c + dz*s,
               pivot[1] + (camera[:height] - elevation) / unit,
               pivot[2] - dx*s + dz*c]
        target = [eye[0] - s*camera[:cos_pitch],
                  eye[1] - camera[:sin_pitch], eye[2] - c*camera[:cos_pitch]]
        points = bbox_view_points(metrics, eye, target)
        return nil unless points
        xs = points.map { |p| p[0]/p[2] }
        ys = points.map { |p| p[1]/p[2] }
        mid_x, mid_y = (xs.min+xs.max)/2, (ys.min+ys.max)/2
        extent = [(xs.max-xs.min)*height/width, ys.max-ys.min, 0.0001].max
        focal = height / (extent * (MODEL_BAKE_FRAME_MARGIN rescue 1.04))
        # Structural meshes meet the terrain's screen-space raster. A bbox-fit
        # focal changes their sampling lattice on every scroll even though the
        # analytic projection agrees. Use a fixed screen pixel density and an
        # integer screen-space window instead; only the window translates.
        if data["modular"] == true
          # Match the terrain's one sample per screen pixel. Props retain the
          # existing supersampling; structural contact edges must not resample.
          density = 1.0
          screen_left = (camera[:center_x] + camera[:focal] * xs.min).floor - 2
          screen_top = (camera[:center_y] - camera[:focal] * ys.max).floor - 2
          span_x = camera[:center_x] + camera[:focal] * xs.max - screen_left + 2
          span_y = camera[:center_y] - camera[:focal] * ys.min - screen_top + 2
          span = [span_x, span_y].max
          density *= 0.5 while span * density > MAX_BITMAP
          required = [[((span * density) / 32.0).ceil * 32, 64].max, MAX_BITMAP].min
          # Instances share one Model3D (and its single cached depth RBO).
          # Different target sizes otherwise reallocate that RBO per instance.
          id = data["id"].to_s
          width = height = [width, height, required, @raster_sizes[id] || 0].max
          @raster_sizes[id] = width
          focal = camera[:focal] * density
          mid_x = (width / 2.0 - density * (camera[:center_x] - screen_left)) / focal
          mid_y = (density * (camera[:center_y] - screen_top) - height / 2.0) / focal
          raster_rect = Rect.new(0, 0, (span_x * density).ceil, (span_y * density).ceil)
        end
        model.camera_fov = 2*Math.atan(height/(2*focal))*180/Math::PI
        model.camera_x, model.camera_y, model.camera_z = eye
        model.camera_target_x, model.camera_target_y, model.camera_target_z = target
        model.camera_shift_x = focal*mid_x
        model.camera_shift_y = focal*mid_y
        # Normals include the asset pose; only instance yaw is represented by
        # the camera. Inverse-rotate the world light into that same local space.
        model.light_x = 0.5*c + 0.8*s
        model.light_y = 1.0
        model.light_z = -0.5*s + 0.8*c
        pdx, pdy, pdz = pivot[0]-eye[0], pivot[1]-eye[1], pivot[2]-eye[2]
        vx = c*pdx-s*pdz
        vy = -s*camera[:sin_pitch]*pdx + camera[:cos_pitch]*pdy - c*camera[:sin_pitch]*pdz
        depth = -s*camera[:cos_pitch]*pdx-camera[:sin_pitch]*pdy-c*camera[:cos_pitch]*pdz
        ground = [focal/depth, width/2.0+focal*(vx/depth-mid_x), height/2.0-focal*(vy/depth-mid_y)]
        [angle, anchor_x, anchor_y, [elevation, scale, camera, model.camera_fov],
         raster_rect || Rect.new(0, 0, width, height), ground, width]
      end

      def model_unit_scale(data)
        vertices = framing_vertices(data)
        return 1.0 if vertices.empty?
        spans = 3.times.map { |axis| values = vertices.map { |v| v[axis].to_f }; values.max-values.min }
        height = spans[1] > 0.001 ? spans[1] : [*spans, 0.001].max
        (data["pixelHeight"] || 96).to_f.clamp(data["modular"] ? 1 : 16, 768) / height
      end
    end

    class Surface
      attr_reader :bitmap, :source_rect, :ground_depth_ratio
      attr_reader :ground_unit_px, :ground_center_px, :ground_base_px
      attr_reader :world_unit_px, :mesh_width_px, :mesh_depth_px
      attr_reader :surface_mapping
      attr_accessor :model_occlusion

      def initialize(data)
        @data = data
        @animation_data = data
        @animation_frame = 0
        @animation_seconds = 0.0
        @animation_last_time = nil
        @animation_frame_data = {}
        @model = NativeRenderer.model_for(data)
        @metrics = NativeRenderer.vertex_metrics(data)
        @scale_metrics = NativeRenderer.vertex_metrics(data, false)
        @ground_depth_ratio = if @metrics
                                @metrics[:span_z] / @metrics[:span_x]
                              else
                                data["footprintD"].to_f /
                                  [data["footprintW"].to_f, 0.001].max
                              end
        # World px per model unit, matching the ratio configure_view uses to
        # place the bake camera. The mesh is treated as isotropic at X's scale:
        # footprintD describes how many cells the asset occupies, not the depth
        # of the geometry, so a shallow fence in a 1x1 cell is 9.6px deep rather
        # than a full 32.
        footprint_w = [data["footprintW"].to_f, 1.0].max * TILE_SIZE
        footprint_d = [data["footprintD"].to_f, 1.0].max * TILE_SIZE
        span_x = @metrics ? @metrics[:span_x] : 1.0
        span_z = @metrics ? @metrics[:span_z] : 1.0
        @world_unit_px = NativeRenderer.model_unit_scale(data)
        # Mesh extents in world px. Only used before the first bake.
        @mesh_width_px = span_x * @world_unit_px
        @mesh_depth_px = @metrics ? span_z * @world_unit_px : footprint_d
        @ground_unit_px = nil
        @ground_center_px = nil
        @ground_base_px = nil
        @bitmap = nil
        @source_rect = nil
        @position_bitmap = nil
        @surface_mapping = nil
        @position_failed = false
        @last_key = nil
        @last_render_frame = -1_000_000
        @has_rendered = false
        NativeRenderer.retain_animation(data)
      end

      # Existing ModelVisual refresh owns the clock; disabled means rest pose.
      # No timer/thread, no bitmap allocation, and no per-frame file writes.
      def update_animation(enabled, now = Process.clock_gettime(Process::CLOCK_MONOTONIC), speed = 1.0)
        return if @animation_broken
        clip = NativeRenderer.animation_clip(@animation_data)
        return unless clip
        elapsed = @animation_last_time ? [now - @animation_last_time, 0.0].max : 0.0
        @animation_last_time = now
        speed = Float(speed) rescue 1.0
        speed = 1.0 unless speed.finite?
        speed = speed.clamp(0.1, 4.0)
        @animation_seconds = enabled ? @animation_seconds + elapsed * speed : 0.0
        frame = NativeRenderer.animation_frame_index(@animation_data, enabled, @animation_seconds)
        return if frame == @animation_frame
        data = @animation_frame_data[frame] ||= if frame == 0
          @animation_data
        else
          @animation_data.merge('id' => "#{@animation_data['id']}/animation/#{frame}",
            'sourceObj' => clip['frames'][frame]['sourceObj'])
        end
        model = NativeRenderer.model_for(data)
        @data, @model, @animation_frame = data, model, frame
        @last_key = nil
      rescue => error
        # Stop retrying a broken clip every refresh; retain its last valid pose.
        @animation_broken = true
        Console.echo_error("Pseudo3D animation: #{error.message}") if defined?(Console)
      end

      def render_world(rotation, x, y, scale, camera, elevation = 0.0,
                       world_x = nil, world_y = nil, map_id = nil)
        supersample = [(GPU_MODEL_SUPERSAMPLE rescue 2.0).to_f, 1.0].max
        footprint_w = [@data["footprintW"].to_f, 1.0].max * TILE_SIZE
        footprint_d = [@data["footprintD"].to_f, 1.0].max * TILE_SIZE
        pixel_height = [(@data["pixelHeight"] || DEFAULT_HEIGHT).to_f, 1.0].max
        extent = [footprint_w, footprint_d, pixel_height].max
        size = ((extent * supersample * 1.15 / 16.0).ceil * 16).to_i
        size = [[size, 64].max, MAX_BITMAP].min
        size = 64 if @data["modular"] == true
        # Keep a grown target while this surface lives; crossing a size bucket
        # back and forth must not reallocate its colour/height FBOs each frame.
        size = [size, @bitmap.width].max if @bitmap && !@bitmap.disposed? && @data["modular"] == true
        view = NativeRenderer.configure_view(@model, @metrics, @data, rotation,
                                             x, y, scale, camera, elevation,
                                             size, size, @scale_metrics)
        return nil unless view
        size = view[6] || size
        if @bitmap && !@bitmap.disposed? &&
           (@bitmap.width != size || @bitmap.height != size)
          @bitmap.dispose
          @bitmap = nil
          @source_rect = nil
          @position_bitmap.dispose if @position_bitmap && !@position_bitmap.disposed?
          @position_bitmap = nil
          @surface_mapping = nil
          @position_failed = false
          @last_key = nil
          @has_rendered = false
        end
        @bitmap ||= Bitmap.new(size, size)

        # Depend only on the render size and the camera setup, so they stay
        # valid for the cached bitmap between bakes.
        return nil unless view
        ground = view[5]
        # Analytic crop: the bbox is projected through the same matrices the
        # bake used, so no bitmap pixels are read. opaque_rect scanned the whole
        # bitmap in Ruby (~590k iterations for a 768px bake), which was the
        # expensive part of the old redraw path.
        projected_rect = view[4]
        view_key = view[0..3]
        key = [size, view_key]
        if @last_key != key
          interval = [(MODEL_RENDER_MIN_INTERVAL rescue 1).to_i, 1].max
          ready = Graphics.frame_count - @last_render_frame >= interval
          # Every visible model needs the current perspective. A shared cap
          # consumed in instance order starves later placements indefinitely:
          # moving their flat quad cannot update the faces in the old bake.
          # Keep the per-surface interval, but never ration slots between props.
          # Joining geometry stays synchronous; unchanged views still reuse
          # both passes, and render() reuses the bitmap/FBO without pixel reads.
          if @data["modular"] == true || ready || !@has_rendered
            @model.render(size, size, @bitmap)
            if ground
              @ground_unit_px, @ground_center_px, @ground_base_px = ground
            end
            # The projected silhouette changes with every observation angle, so
            # the crop is recomputed for each fresh bake. Falling back to the
            # whole bitmap only happens when the bbox projection degenerates.
            @source_rect = projected_rect ||
                           Rect.new(0, 0, @bitmap.width, @bitmap.height)
            @last_key = key
            @last_render_frame = Graphics.frame_count
            @has_rendered = true
            @position_failed = false
            render_position_pass(rotation, world_x, world_y, scale, size, map_id, elevation)
          end
        end
        # The fog layer registry fills in during the same frame the spriteset
        # first renders, after this surface's first bake. Retry only while the
        # cached colour bake still matches the current view key: the position
        # pass copies @model's camera, which configure_view refreshes every
        # call, so baking against a stale colour bitmap would misalign the two
        # passes. While scrolling, view_key changes instead and the next fresh
        # bake carries the position pass inline.
        if @has_rendered && !@surface_mapping && !@position_failed &&
           @last_key == key && world_x && world_y &&
           Camera.respond_to?(:object_fog_available?) &&
           (model_occlusion || Camera.object_fog_available?(map_id))
          render_position_pass(rotation, world_x, world_y, scale,
                               @bitmap.width, map_id, elevation)
        end
        @surface_mapping[:height_min] = surface_height_min(elevation, scale) if @surface_mapping
        @has_rendered ? @bitmap : nil
      rescue => e
        Console.echo_error("Pseudo3D Model3D render: #{e.message}") if defined?(Console)
        nil
      end

      # Bake a second bitmap encoding each surface pixel's 16-bit height
      # (model_position.frag), pixel-aligned with the colour bake
      # because both use the same view_key, camera, and crop. object_fog.frag
      # consumes it via modelPositionTexture so a cloud edge can slide along a
      # wall with height instead of stamping one ground-plane sample per
      # surface. The fragment shader reconstructs XZ from the displayed quad
      # and the map camera, keeping the ground contact aligned while scrolling.
      def render_position_pass(_rotation, world_x, world_y, scale, size,
                               map_id = nil, elevation = 0.0)
        @surface_mapping = nil
        if @position_failed || !@metrics || !world_x || !world_y ||
           !Camera.respond_to?(:object_fog_available?) ||
           (!model_occlusion && !Camera.object_fog_available?(map_id))
          # No consumer: release the bake instead of keeping GPU memory alive.
          if @position_bitmap && !@position_bitmap.disposed?
            @position_bitmap.dispose
            @position_bitmap = nil
          end
          return
        end
        position_model = NativeRenderer.position_model_for(@data)
        return unless position_model
        shader = NativeRenderer.position_shader
        # v_fragPos includes mesh offsets and is in the same space as metrics.
        # Subtract the floor before encoding height into the 0..1 channel.
        height_span = [@metrics[:span_y] * @world_unit_px * scale.to_f,
                       TILE_SIZE].max
        shader.set_float("u_heightScale", @world_unit_px * scale.to_f / height_span)
        shader.set_float("u_heightBase", @metrics[:min_y])
        # Copy the colour bake's camera so both passes frame identically.
        position_model.camera_fov = @model.camera_fov
        position_model.camera_x = @model.camera_x
        position_model.camera_y = @model.camera_y
        position_model.camera_z = @model.camera_z
        position_model.camera_target_x = @model.camera_target_x
        position_model.camera_target_y = @model.camera_target_y
        position_model.camera_target_z = @model.camera_target_z
        position_model.camera_shift_x = @model.camera_shift_x
        position_model.camera_shift_y = @model.camera_shift_y
        if @position_bitmap && !@position_bitmap.disposed? &&
           (@position_bitmap.width != size || @position_bitmap.height != size)
          @position_bitmap.dispose
          @position_bitmap = nil
        end
        @position_bitmap ||= Bitmap.new(size, size)
        position_model.render(size, size, @position_bitmap)
        @surface_mapping = {
          :position_bitmap => @position_bitmap,
          :height_min => surface_height_min(elevation, scale),
          :height_span => height_span
        }
      rescue => e
        Console.echo_error("Pseudo3D position bake: #{e.message}") if defined?(Console)
        @position_bitmap = nil
        @surface_mapping = nil
        # Do not re-attempt a broken pass every frame; the renderer falls back
        # to the pixel-anchor mapping until the next view_key bake.
        @position_failed = true
        nil
      end

      def surface_height_min(elevation, scale)
        return elevation.to_f unless model_occlusion && @metrics
        pivot = @data['pivotY'].to_f + @data['meshOffsetY'].to_f
        elevation.to_f + (@metrics[:min_y]-pivot) * @world_unit_px * scale.to_f
      end

      def dispose
        NativeRenderer.release_animation(@animation_data) if @animation_data
        @animation_data = nil
        @bitmap.dispose if @bitmap && !@bitmap.disposed?
        @bitmap = nil
        @position_bitmap.dispose if @position_bitmap && !@position_bitmap.disposed?
        @position_bitmap = nil
        @surface_mapping = nil
        @model = nil
      end
    end
  end
end
