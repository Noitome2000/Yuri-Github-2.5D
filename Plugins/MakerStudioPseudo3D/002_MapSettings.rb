# encoding: UTF-8
# Per-map rendering settings. PBS is read once at boot, never in the frame loop.
module MakerStudioPseudo3D
  module MapSettings
    SOURCE_PATH = 'PBS/map_3d.txt'
    CACHE_PATH = 'Data/map_3d.dat'
    # PBS name => [runtime key, type, allowed range/values]
    SCHEMA = {
      'Mode' => [:mode, :enum, %w[2D 2.5D Inherit]],
      'CameraPitch' => [:CAMERA_PITCH_DEGREES, :float, 1.0..89.0],
      'CameraTarget' => [:CAMERA_TARGET_RATIO, :float, 0.05..0.95],
      'CameraFocalLength' => [:CAMERA_FOCAL_LENGTH_RATIO, :float, 0.0..10.0],
      'CameraHorizon' => [:CAMERA_HORIZON_RATIO, :float, 0.0..0.95],
      'FarDistance' => [:CAMERA_FAR_TILES, :float, 8.0..128.0],
      'ShowPanorama' => [:CAMERA_SHOW_PANORAMA, :bool],
      'DynamicShadows' => [:CAMERA_DYNAMIC_SHADOWS, :bool],
      'Lighting' => [:PSEUDO3D_LIGHTING_ENABLED, :bool],
      'AmbientTone' => [:PSEUDO3D_AMBIENT_TONE, :float, -255.0..255.0],
      'ShadowAngle' => [:PSEUDO3D_SHADOW_ANGLE_DEGREES, :float, 0.0..360.0],
      'ShadowLength' => [:PSEUDO3D_SHADOW_LENGTH, :float, 0.0..8.0],
      'ShadowOpacity' => [:PSEUDO3D_SHADOW_OPACITY, :int, 0..255],
      'CloudHeightParallax' => [:PSEUDO3D_CLOUD_HEIGHT_PARALLAX, :float, 0.0..8.0],
      'SoftenCloudEdges' => [:PSEUDO3D_OBJECT_FOG_SOFTEN_EDGES, :bool],
      'ModelGroundOffset' => [:MODEL_GROUND_OFFSET_PIXELS, :float, -256.0..256.0],
      'EffectPreset' => ['preset', :enum, %w[none cartoon hd2d]],
      'PointLighting' => ['lighting', :bool],
      'AmbientLight' => ['ambient', :float, 0.1..1.5],
      'EffectStrength' => ['strength', :float, 0.0..1.0],
      'Bloom' => ['bloom', :float, 0.0..0.5],
      'DepthOfField' => ['dof', :float, 0.0..1.0],
      'MaxLights' => ['maxLights', :int, 1..8]
    }.freeze
    EMPTY = {}.freeze

    class << self
      def parse(text, path = SOURCE_PATH)
        sections = {}
        section = nil
        text.sub(/\A\uFEFF/, '').each_line.with_index(1) do |raw, line_no|
          line = raw.sub(/[#;].*$/, '').strip
          next if line.empty?
          error_prefix = "#{path}:#{line_no}: "
          if (match = /\A\[([^\]]+)\]\z/.match(line))
            label = match[1].strip
            section = if label.casecmp('Default') == 0
                        :default
                      elsif label.match?(/\A\d+\z/) && label.to_i > 0
                        label.to_i
                      else
                        raise ArgumentError, error_prefix + 'section must be [Default] or a positive map ID'
                      end
            raise ArgumentError, error_prefix + "duplicate section [#{label}]" if sections.key?(section)
            sections[section] = {}
            next
          end
          raise ArgumentError, error_prefix + 'property needs a [map ID] section' unless section
          match = /\A(\w+)\s*=\s*(.*?)\s*\z/.match(line)
          raise ArgumentError, error_prefix + 'expected Property = Value' unless match
          name, raw_value = match.captures
          spec = SCHEMA[name]
          raise ArgumentError, error_prefix + "unknown property #{name}" unless spec
          key, type, allowed = spec
          raise ArgumentError, error_prefix + "duplicate property #{name}" if sections[section].key?(key)
          begin
            value = case type
                    when :bool
                      raise ArgumentError unless %w[true false].include?(raw_value.downcase)
                      raw_value.downcase == 'true'
                    when :int
                      raise ArgumentError unless raw_value.match?(/\A[+-]?\d+\z/)
                      Integer(raw_value, 10)
                    when :float
                      number = Float(raw_value)
                      raise ArgumentError unless number.finite?
                      number
                    when :enum
                      allowed.find { |item| item.casecmp(raw_value) == 0 } || (raise ArgumentError)
                    end
            raise ArgumentError if allowed.is_a?(Range) && !allowed.cover?(value)
          rescue ArgumentError, TypeError
            expectation = type == :bool ? 'true or false' : allowed.inspect
            raise ArgumentError, error_prefix + "invalid #{name}=#{raw_value.inspect}; expected #{expectation}"
          end
          sections[section][key] = value
        end
        sections
      end

      def load!(source = SOURCE_PATH, cache = CACHE_PATH)
        data = if File.exist?(source)
                 parse(File.read(source, encoding: 'UTF-8'), source)
               elsif File.exist?(cache) || (defined?(pbRgssExists?) && pbRgssExists?(cache))
                 payload = defined?(load_data) ? load_data(cache) : Marshal.load(File.binread(cache))
                 raise ArgumentError, "#{cache}: unsupported map rendering cache" unless payload.is_a?(Hash) && payload[:version] == 1 && payload[:sections].is_a?(Hash)
                 payload[:sections]
               else
                 {}
               end
        @sections = data
        @effective = {}
        @effects = {}
      end

      def compile!(source = SOURCE_PATH, cache = CACHE_PATH)
        return unless File.exist?(source)
        sections = parse(File.read(source, encoding: 'UTF-8'), source)
        payload = {version: 1, sections: sections}
        temp = "#{cache}.tmp"
        File.binwrite(temp, Marshal.dump(payload))
        File.rename(temp, cache)
        load!(source, cache)
      end

      def current_map_id
        $game_map ? $game_map.map_id : 0
      end

      def for_map(map_id = current_map_id)
        @effective[map_id] ||= (@sections[:default] || EMPTY).merge(@sections[map_id] || EMPTY).freeze
      end

      def value(key, map_id = current_map_id)
        settings = for_map(map_id)
        return settings[key] if settings.key?(key)
        MakerStudioPseudo3D.const_get(key)
      end

      def mode(map_id = current_map_id)
        result = for_map(map_id)[:mode]
        result == 'Inherit' ? nil : result
      end

      def effects(map_id, authored)
        previous = @effects[map_id]
        return previous[1] if previous && previous[0].equal?(authored)
        overrides = for_map(map_id).select { |key, _| key.is_a?(String) }
        result = (authored || EMPTY).merge(overrides).freeze
        @effects[map_id] = [authored, result]
        result
      end
    end
    load!
  end
end

if defined?(Compiler)
  module MakerStudioMapSettingsCompiler
    def compile_all(*args)
      super
      MakerStudioPseudo3D::MapSettings.compile!
    end
  end
  Compiler.singleton_class.prepend(MakerStudioMapSettingsCompiler)
end
