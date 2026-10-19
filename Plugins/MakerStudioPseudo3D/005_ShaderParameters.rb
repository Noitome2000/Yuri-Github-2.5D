# frozen_string_literal: true

module MakerStudioPseudo3D
  # Attached only to shaders owned by this plugin. MKXP stores uniforms on each
  # Ruby Shader and reapplies them when drawing, even when programs are shared.
  # Avoid repeated Ruby -> native calls/graphics locks for unchanged numbers;
  # The native shader retains its Bitmap pointers and binds them on every draw.
  module ShaderParameters
    def set_float(name, value)
      entry = @p3d_parameters && @p3d_parameters[name]
      return nil if entry && entry[0] == :float && entry[1] == value
      super
      remember_p3d_parameter(name, :float, value)
    end

    def set_int(name, value)
      entry = @p3d_parameters && @p3d_parameters[name]
      return nil if entry && entry[0] == :int && entry[1] == value
      super
      remember_p3d_parameter(name, :int, value)
    end

    def set_vec2(name, x, y)
      entry = @p3d_parameters && @p3d_parameters[name]
      return nil if entry && entry[0] == :vec2 && entry[1] == x && entry[2] == y
      super
      remember_p3d_parameter(name, :vec2, x, y)
    end

    def set_vec3(name, x, y, z)
      entry = @p3d_parameters && @p3d_parameters[name]
      return nil if entry && entry[0] == :vec3 && entry[1] == x && entry[2] == y && entry[3] == z
      super
      remember_p3d_parameter(name, :vec3, x, y, z)
    end

    def set_vec4(name, x, y, z, w)
      entry = @p3d_parameters && @p3d_parameters[name]
      return nil if entry && entry[0] == :vec4 && entry[1] == x && entry[2] == y && entry[3] == z && entry[4] == w
      super
      remember_p3d_parameter(name, :vec4, x, y, z, w)
    end

    def set_bitmap(name, bitmap)
      entry = @p3d_parameters && @p3d_parameters[name]
      return nil if entry && entry[0] == :bitmap && entry[1].equal?(bitmap) &&
                    (!bitmap || !bitmap.disposed?)
      super
      remember_p3d_parameter(name, :bitmap, bitmap)
    end

    # The plugin currently uses no matrices, but a later matrix assignment must
    # invalidate an earlier scalar/vector with the same name.
    def set_mat4(name, values)
      super
      @p3d_parameters.delete(name) if @p3d_parameters
      nil
    end

    def dispose
      super
    ensure
      # Release keys, and let all future setters reach MKXP's disposed guard.
      @p3d_parameters = nil
    end

    private

    def remember_p3d_parameter(name, type, x, y = nil, z = nil, w = nil)
      @p3d_parameters ||= {}
      entry = (@p3d_parameters[name] ||= [])
      # Update existing slots in place; animated uniforms allocate no new array.
      entry[0] = type
      entry[1] = x
      entry[2] = y
      entry[3] = z
      entry[4] = w
      nil
    end
  end
end
