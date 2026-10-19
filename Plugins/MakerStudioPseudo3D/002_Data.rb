settings_path = "Plugins/MakerStudioPseudo3D/001_Settings.rb"
if File.exist?(settings_path)
  previous_verbose = $VERBOSE
  begin
    $VERBOSE = nil
    load(settings_path)
  ensure
    $VERBOSE = previous_verbose
  end
end

# mkxp-z includes Ruby's native JSON extension. It parses the multi-megabyte
# model library much faster than the compatibility parser below.
begin
  require "json" unless defined?(JSON)
rescue LoadError
  # JoiPlay/older RGSS runtimes can continue to use the fallback parser.
end

module MakerStudioPseudo3DJSON
  class Parser
    def initialize(text)
      @text = text
      @index = 0
    end

    def parse
      value = parse_value
      skip_space
      raise "Unexpected trailing JSON data" if @index < @text.length
      value
    end

    def parse_value
      skip_space
      case peek
      when "{" then parse_object
      when "[" then parse_array
      when '"' then parse_string
      when "t" then literal("true", true)
      when "f" then literal("false", false)
      when "n" then literal("null", nil)
      else parse_number
      end
    end

    def parse_object
      result = {}
      take("{")
      skip_space
      return result.tap { take("}") } if peek == "}"
      loop do
        key = parse_string
        take(":")
        result[key] = parse_value
        break if peek == "}"
        take(",")
      end
      take("}")
      result
    end

    def parse_array
      result = []
      take("[")
      skip_space
      return result.tap { take("]") } if peek == "]"
      loop do
        result << parse_value
        break if peek == "]"
        take(",")
      end
      take("]")
      result
    end

    def parse_string
      take('"')
      result = +""
      while @index < @text.length
        char = @text[@index]
        @index += 1
        return result if char == '"'
        unless char == "\\"
          result << char
          next
        end
        escape = @text[@index]
        @index += 1
        result << case escape
                  when '"', "\\", "/" then escape
                  when "b" then "\b"
                  when "f" then "\f"
                  when "n" then "\n"
                  when "r" then "\r"
                  when "t" then "\t"
                  when "u"
                    hex = @text[@index, 4]
                    @index += 4
                    [hex.to_i(16)].pack("U")
                  else raise "Invalid JSON escape"
                  end
      end
      raise "Unterminated JSON string"
    end

    def parse_number
      start = @index
      @index += 1 while @index < @text.length && @text[@index] =~ /[0-9eE+\-.]/
      raw = @text[start...@index]
      raise "Invalid JSON value" if !raw || raw.empty?
      raw.include?(".") || raw =~ /[eE]/ ? raw.to_f : raw.to_i
    end

    def literal(word, value)
      raise "Invalid JSON literal" unless @text[@index, word.length] == word
      @index += word.length
      value
    end

    def skip_space
      @index += 1 while @index < @text.length && @text[@index] =~ /\s/
    end

    def peek
      skip_space
      @text[@index]
    end

    def take(expected)
      skip_space
      raise "Expected #{expected.inspect}" unless @text[@index] == expected
      @index += 1
    end
  end

  def self.parse(text)
    Parser.new(text).parse
  end
end

module MakerStudioPseudo3D
  @library = nil
  @asset_index = nil
  @texture_index = nil
  @scenes = {}
  @collisions = {}
  @renderer_count = 0

  class << self
    def read_json(path, fallback)
      return fallback unless File.exist?(path)
      raw = File.open(path, "rb") { |file| file.read }
      defined?(JSON) ? JSON.parse(raw) : MakerStudioPseudo3DJSON.parse(raw)
    rescue => error
      Console.echo_error("Pseudo3D: #{path}: #{error.message}") if defined?(Console)
      fallback
    end

    def read_library
      source_path = "#{DATA_DIR}/library.json"
      cache_path = "#{DATA_DIR}/library.rxdata"
      return { "assets" => [] } unless File.exist?(source_path)
      # The native parser is faster than loading Marshal on mkxp-z. The cache
      # primarily guarantees fast startup on runtimes without that extension.
      return read_json(source_path, { "assets" => [] }) if defined?(JSON)
      stat = File.stat(source_path)
      signature = "#{stat.size}:#{stat.mtime.to_f}"
      if File.exist?(cache_path)
        begin
          cached = File.open(cache_path, "rb") { |file| Marshal.load(file) }
          return cached["library"] if cached["signature"] == signature
        rescue
          # A partial/old cache is harmless; rebuild it from the JSON source.
        end
      end
      data = read_json(source_path, { "assets" => [] })
      begin
        payload = { "signature" => signature, "library" => data }
        File.open(cache_path, "wb") { |file| Marshal.dump(payload, file) }
      rescue => error
        Console.echo_error("Pseudo3D library cache: #{error.message}") if defined?(Console)
      end
      data
    end

    def library
      return @library if @library
      @library = read_library
      @asset_index = {}
      (@library["assets"] || []).each do |entry|
        @asset_index[entry["id"].to_s] = entry
      end
      @texture_index = {}
      (@library["textures"] || []).each do |entry|
        @texture_index[entry["id"].to_s] = entry
      end
      @library
    end

    def scene(map_id)
      @scenes[map_id] ||= read_json(format("%s/Map%03d.json", DATA_DIR, map_id), nil)
    end

    def asset(id)
      library unless @asset_index
      @asset_index[id.to_s]
    end

    def texture(id)
      library unless @texture_index
      @texture_index[id.to_s]
    end

    def collision_for(map_id)
      return @collisions[map_id] if @collisions.key?(map_id)
      data = scene(map_id)
      cells = {}
      if data
        (data["instances"] || []).each do |instance|
          next if instance["visible"] == false || instance["collision"] == false
          next if instance["walkable"] == true && asset(instance["assetId"])&.fetch("type", nil) == "model"
          model = asset(instance["assetId"])
          next unless model
          width = [(instance["footprintW"] || model["footprintW"] || 1).to_i, 1].max
          depth = [(instance["footprintD"] || model["footprintD"] || 1).to_i, 1].max
          start_x = instance["x"].to_i.div(TILE_SIZE)
          start_y = instance["y"].to_i.div(TILE_SIZE)
          width.times do |dx|
            depth.times { |dy| cells[[start_x + dx, start_y + dy]] = true }
          end
        end
      end
      @collisions[map_id] = cells
    end

    def ensure_directory(path)
      current = ""
      path.tr("\\", "/").split("/").each do |part|
        current = current.empty? ? part : "#{current}/#{part}"
        Dir.mkdir(current) unless Dir.exist?(current)
      end
    end

    def image_path(model)
      data_uri = model["image"].to_s
      return nil unless data_uri.start_with?("data:image/") && data_uri.include?(",")
      header, encoded = data_uri.split(",", 2)
      extension = header.include?("jpeg") ? "jpg" : "png"
      safe_id = model["id"].to_s.gsub(/[^a-zA-Z0-9_-]/, "_")
      ensure_directory(CACHE_DIR)
      path = "#{CACHE_DIR}/#{safe_id}.#{extension}"
      signature_path = "#{path}.sig"
      checksum = 2_166_136_261
      encoded.each_byte { |byte| checksum = ((checksum ^ byte) * 16_777_619) & 0xffffffff }
      signature = "#{encoded.length}:#{checksum}"
      saved_signature = File.exist?(signature_path) ? File.open(signature_path, "rb") { |file| file.read } : nil
      if saved_signature != signature || !File.exist?(path)
        binary = encoded.gsub(/\s+/, "").unpack1("m0")
        File.open(path, "wb") { |file| file.write(binary) }
        File.open(signature_path, "wb") { |file| file.write(signature) }
      end
      path
    rescue => error
      Console.echo_error("Pseudo3D image #{model['name']}: #{error.message}") if defined?(Console)
      nil
    end

    # Native mkxp-z-ext Model3D loads OBJ/MTL through the game's virtual
    # filesystem, but the Ruby side still needs a canonical project-relative
    # path.  sourceObj is authored by MakerStudio and uses forward slashes.
    def obj_path(model)
      value = model && (model["sourceObj"] || model[:sourceObj])
      path = value.to_s.tr("\\", "/")
      return nil if path.empty?
      path
    end

    def mtl_path(obj_path)
      path = obj_path.to_s.tr("\\", "/")
      return nil if path.empty?
      dot = path.rindex(".")
      slash = path.rindex("/") || -1
      dot && dot > slash ? "#{path[0...dot]}.mtl" : "#{path}.mtl"
    end

    def retain_renderer
      @renderer_count += 1
    end

    def release_renderer
      @renderer_count = [@renderer_count - 1, 0].max
      # A map transition briefly has no renderer. Keep parsed geometry and GPU
      # model handles alive so the next map does not reload shared OBJ assets.
    end

    def clear
      @library = nil
      @asset_index = nil
      @texture_index = nil
      @scenes.clear
      @collisions.clear
      NativeRenderer.clear if defined?(NativeRenderer)
    end
  end
end
