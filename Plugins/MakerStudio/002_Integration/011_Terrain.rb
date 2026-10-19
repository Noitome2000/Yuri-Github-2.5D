#===============================================================================
# Maker Studio - layered height fields, overpasses and terrain slopes
#===============================================================================
module MakerStudio
  TERRAIN_DATA_DIR = File.join("Data", "MakerStudioTerrain")
  TERRAIN_DEFAULT_STEP = 16
  TERRAIN_OVERPASS_THICKNESS = 8.0
  @terrain_cache = {}
  @terrain_render_cache = {}

  module_function

  def terrain_path(map_id)
    File.join(TERRAIN_DATA_DIR, format("Map%03d.json", map_id.to_i))
  end

  def empty_terrain
    { "schemaVersion" => 2, "heightStep" => TERRAIN_DEFAULT_STEP, "cells" => {} }
  end

  def load_terrain(map_id)
    path = terrain_path(map_id)
    return empty_terrain unless File.exist?(path)
    raw = File.open(path, "rb") { |file| file.read }
    data = MakerStudio::JSON.parse(raw)
    data["heightStep"] = [[(data["heightStep"] || TERRAIN_DEFAULT_STEP).to_i, 4].max, 64].min
    data["cells"] = {} unless data["cells"].is_a?(Hash)
    data
  rescue => error
    Console.echo_error("MakerStudio terrain map #{map_id}: #{error.message}") if defined?(Console)
    empty_terrain
  end

  def terrain_for(map_id)
    @terrain_cache[map_id.to_i] ||= load_terrain(map_id)
  end

  def clear_terrain(map_id = nil)
    if map_id
      @terrain_cache.delete(map_id.to_i)
      @terrain_render_cache.delete(map_id.to_i)
    else
      @terrain_cache.clear
      @terrain_render_cache.clear
    end
  end

  def terrain_cell(map_id, x, y)
    terrain_for(map_id)["cells"]["#{x.to_i},#{y.to_i}"]
  end

  def terrain_height_step(map_id)
    terrain_for(map_id)["heightStep"].to_i
  end

  def terrain_revision(map_id)
    data = terrain_for(map_id)
    [data.object_id, (data["revision"] || 0).to_i, data["heightStep"].to_i]
  end

  def terrain_overpass?(cell)
    cell && cell["type"] == "overpass" && cell["height"].to_i > 0
  end

  def terrain_edge_style(cell)
    style = cell && cell["style"]
    ["hard", "soft", "round"].include?(style) ? style : "hard"
  end

  # Parsed once because sparse rows keep camera culling proportional to what is visible.
  def terrain_render_rows(map_id)
    id = map_id.to_i
    data = terrain_for(id)
    signature = terrain_revision(id)
    cached = @terrain_render_cache[id]
    return cached[:rows] if cached && cached[:signature] == signature
    rows = {}
    data["cells"].each do |key, cell|
      match = key.to_s.match(/\A(-?\d+),(-?\d+)\z/)
      next unless match && cell.is_a?(Hash)
      x = match[1].to_i
      y = match[2].to_i
      rows[y] ||= []
      rows[y] << [x, cell]
    end
    rows.each_value { |entries| entries.sort_by! { |entry| entry[0] } }
    @terrain_render_cache[id] = { :signature => signature, :rows => rows }
    rows
  end

  def terrain_render_cells(map_id, min_x, min_y, max_x, max_y)
    result = []
    rows = terrain_render_rows(map_id)
    (min_y.to_i..max_y.to_i).each do |y|
      entries = rows[y]
      next unless entries
      entries.each do |x, cell|
        next if x < min_x
        break if x > max_x
        result << [x, y, cell]
      end
    end
    result
  end

  # Corner order: northwest, northeast, southwest, southeast.
  def terrain_corner_levels(cell)
    height = cell ? [cell["height"].to_i, 0].max : 0
    case cell && cell["slope"]
    when "north" then [height + 1, height + 1, height, height]
    when "east"  then [height, height + 1, height, height + 1]
    when "south" then [height, height, height + 1, height + 1]
    when "west"  then [height + 1, height, height + 1, height]
    when "outer_north_west" then [height + 1, height, height, height]
    when "outer_north_east" then [height, height + 1, height, height]
    when "outer_south_west" then [height, height, height + 1, height]
    when "outer_south_east" then [height, height, height, height + 1]
    when "inner_north_west" then [height, height + 1, height + 1, height + 1]
    when "inner_north_east" then [height + 1, height, height + 1, height + 1]
    when "inner_south_west" then [height + 1, height + 1, height, height + 1]
    when "inner_south_east" then [height + 1, height + 1, height + 1, height]
    else [height, height, height, height]
    end
  end

  def terrain_center_level(cell)
    terrain_surface_level_at(cell, 0.5, 0.5)
  end

  def terrain_corner_heights(map_id, cell)
    step = terrain_height_step(map_id)
    terrain_corner_levels(cell).map { |level| level.to_f * step }
  end

  def terrain_edge_level(cell, direction)
    nw, ne, sw, se = terrain_corner_levels(cell)
    case direction
    when 8 then (nw + ne) / 2.0
    when 6 then (ne + se) / 2.0
    when 2 then (sw + se) / 2.0
    else        (nw + sw) / 2.0
    end
  end

  def terrain_surface_options(cell, direction)
    top = terrain_edge_level(cell, direction)
    return [[:ground, 0.0], [:top, top]] if terrain_overpass?(cell)
    [[:top, top]]
  end

  def terrain_character_surface(character, cell = nil)
    return :top unless character
    surface = character.instance_variable_get(:@maker_studio_terrain_surface)
    return surface if surface == :ground || surface == :top
    terrain_overpass?(cell) ? :top : :top
  end

  def terrain_transition_passable?(map_id, x, y, direction, width = nil, height = nil, character = nil)
    offsets = { 2 => [0, 1, 8], 4 => [-1, 0, 6], 6 => [1, 0, 4], 8 => [0, -1, 2] }
    move = offsets[direction.to_i]
    return true unless move
    # Game_Character asks once from the source and again from the target. Only
    # the source call is allowed to choose a new overpass layer.
    if character && (x.to_i != character.x.to_i || y.to_i != character.y.to_i)
      return true
    end
    target_x = x.to_i + move[0]
    target_y = y.to_i + move[1]
    return true if width && height &&
                   (target_x < 0 || target_y < 0 || target_x >= width || target_y >= height)
    source = terrain_cell(map_id, x, y)
    target = terrain_cell(map_id, target_x, target_y)
    source_options = terrain_surface_options(source, direction.to_i)
    target_options = terrain_surface_options(target, move[2])
    if character
      wanted_surface = terrain_character_surface(character, source)
      source_option = source_options.find { |item| item[0] == wanted_surface } || source_options[-1]
      target_option = target_options.find { |item| (item[1] - source_option[1]).abs < 0.001 }
      return false unless target_option
      character.instance_variable_set(:@maker_studio_pending_terrain_surface, target_option[0])
      return true
    end
    source_options.any? do |source_option|
      target_options.any? { |target_option| (source_option[1] - target_option[1]).abs < 0.001 }
    end
  end

  def terrain_height_pixels(map_id, x, y, surface = :top)
    cell = terrain_cell(map_id, x, y)
    return 0.0 if surface == :ground && terrain_overpass?(cell)
    terrain_center_level(cell) * terrain_height_step(map_id)
  end

  def terrain_corner_distance(slope, u, v)
    suffix = slope.to_s.sub(/\A(?:outer|inner)_/, "")
    dx = suffix.include?("west") ? u : 1.0 - u
    dy = suffix.include?("north") ? v : 1.0 - v
    Math.sqrt(dx * dx + dy * dy)
  end

  # Outer/inner corners are quarter-cones. Other cells match the renderer's
  # NW-SE triangle split exactly rather than using bilinear interpolation.
  def terrain_surface_level_at(cell, u, v)
    height = cell ? [cell["height"].to_f, 0.0].max : 0.0
    slope = cell ? cell["slope"].to_s : ""
    if slope.start_with?("outer_")
      return height + [1.0 - terrain_corner_distance(slope, u, v), 0.0].max
    elsif slope.start_with?("inner_")
      return height + [terrain_corner_distance(slope, u, v), 1.0].min
    end
    nw, ne, sw, se = terrain_corner_levels(cell).map(&:to_f)
    if u >= v
      nw + u * (ne - nw) + v * (se - ne)
    else
      nw + v * (sw - nw) + u * (se - sw)
    end
  end

  def terrain_height_at_pixel(map_id, pixel_x, pixel_y, character = nil, surface = nil)
    tile_x = (pixel_x.to_f / TILE_WIDTH).floor
    tile_y = (pixel_y.to_f / TILE_HEIGHT).floor
    cell = terrain_cell(map_id, tile_x, tile_y)
    return 0.0 unless cell
    chosen = surface || terrain_character_surface(character, cell)
    return 0.0 if chosen == :ground && terrain_overpass?(cell)
    u = (pixel_x.to_f / TILE_WIDTH) - tile_x
    v = (pixel_y.to_f / TILE_HEIGHT) - tile_y
    terrain_surface_level_at(cell, u, v) * terrain_height_step(map_id)
  end
end

EventHandlers.add(:on_game_map_setup, :maker_studio_terrain_load,
  proc { |map_id, _map, _tileset| MakerStudio.clear_terrain(map_id) }
)

EventHandlers.add(:on_new_game, :maker_studio_terrain_new_game,
  proc { MakerStudio.clear_terrain }
)

class Game_Map
  unless method_defined?(:maker_studio_terrain_passable)
    alias maker_studio_terrain_passable passable?
  end
  def passable?(x, y, d, self_event = nil)
    return false unless MakerStudio.terrain_transition_passable?(
      @map_id, x, y, d, width, height, self_event
    )
    maker_studio_terrain_passable(x, y, d, self_event)
  end

  unless method_defined?(:maker_studio_terrain_player_passable)
    alias maker_studio_terrain_player_passable playerPassable?
  end
  def playerPassable?(x, y, d, self_event = nil)
    return false unless MakerStudio.terrain_transition_passable?(
      @map_id, x, y, d, width, height, self_event
    )
    maker_studio_terrain_player_passable(x, y, d, self_event)
  end

  unless method_defined?(:maker_studio_terrain_passable_strict)
    alias maker_studio_terrain_passable_strict passableStrict?
  end
  def passableStrict?(x, y, d, self_event = nil)
    return false unless MakerStudio.terrain_transition_passable?(
      @map_id, x, y, d, width, height, self_event
    )
    maker_studio_terrain_passable_strict(x, y, d, self_event)
  end
end

class Game_Character
  unless method_defined?(:maker_studio_terrain_character_passable)
    alias maker_studio_terrain_character_passable passable?
  end
  def passable?(x, y, d, strict = false)
    @maker_studio_pending_terrain_surface = nil
    result = maker_studio_terrain_character_passable(x, y, d, strict)
    @maker_studio_pending_terrain_surface = nil unless result
    result
  end

  unless method_defined?(:maker_studio_terrain_increase_steps)
    alias maker_studio_terrain_increase_steps increase_steps
  end
  def increase_steps
    maker_studio_terrain_increase_steps
    if @maker_studio_pending_terrain_surface
      @maker_studio_terrain_surface = @maker_studio_pending_terrain_surface
      @maker_studio_pending_terrain_surface = nil
    end
  end

  unless method_defined?(:maker_studio_terrain_moveto)
    alias maker_studio_terrain_moveto moveto
  end
  def moveto(x, y)
    maker_studio_terrain_moveto(x, y)
    @maker_studio_terrain_surface = nil
    @maker_studio_pending_terrain_surface = nil
  end
end
