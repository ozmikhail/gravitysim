#include "modules/render/trail_renderer.h"

#include "lib/gl/gl.h"
#include "lib/gl/shader.h"
#include "modules/sim/particles.h"

#include <algorithm>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <glad/gl.h>
#include <vector>

namespace grav {

namespace {

constexpr const char* VERTEX_SHADER = R"(#version 410 core
layout(location = 0) in vec3 a_position;
uniform float u_aspect;
void main() {
    gl_Position = vec4(a_position.x / u_aspect, a_position.yz, 1.0);
}
)";

constexpr const char* FRAGMENT_SHADER = R"(#version 410 core
out vec4 frag_color;
void main() {
    frag_color = vec4(0.30, 0.55, 1.0, 0.14);
}
)";

} // namespace

TrailRenderer::~TrailRenderer() {
  if (vao_ != 0) {
    glDeleteVertexArrays(1, &vao_);
    glDeleteBuffers(1, &history_vbo_);
    glDeleteBuffers(1, &index_buffer_);
    gl::delete_program(program_);
  }
}

void TrailRenderer::clear() noexcept {
  next_ = 0;
  samples_ = 0;
}

void TrailRenderer::allocate(std::size_t count) {
  if (vao_ == 0) {
    program_ = gl::compile_program(VERTEX_SHADER, FRAGMENT_SHADER);
    glGenVertexArrays(1, &vao_);
    glGenBuffers(1, &history_vbo_);
    glGenBuffers(1, &index_buffer_);
  }
  slots_ = count;
  clear();

  // Frames are contiguous for GPU copies. Each particle's indices go around the
  // ring twice so any chronological window can be drawn as one line strip.
  std::vector<GLuint> indices(slots_ * history_ * 2);
  for (std::size_t slot = 0; slot < slots_; ++slot) {
    const auto base = slot * history_ * 2;
    for (std::size_t sample = 0; sample < history_; ++sample) {
      const auto vertex = static_cast<GLuint>((sample * slots_) + slot);
      indices.at(base + sample) = vertex;
      indices.at(base + history_ + sample) = vertex;
    }
  }
  draw_counts_.resize(slots_);
  draw_offsets_.resize(slots_);

  glBindVertexArray(vao_);
  glBindBuffer(GL_ARRAY_BUFFER, history_vbo_);
  glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(slots_ * history_ * sizeof(Vec3)), nullptr,
               GL_DYNAMIC_COPY);
  glEnableVertexAttribArray(0);
  glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(Vec3), nullptr);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, index_buffer_);
  glBufferData(GL_ELEMENT_ARRAY_BUFFER, static_cast<GLsizeiptr>(indices.size() * sizeof(GLuint)),
               indices.data(), GL_STATIC_DRAW);
  glBindVertexArray(0);
  gl::check("allocate trail history");
}

void TrailRenderer::record(std::uint32_t position_vbo, const Particles& particles) {
  const auto count = count_particles(particles);
  if (history_ < 2 || count == 0) {
    return;
  }
  const auto slots_needed = id_of(particles, count - 1) + 1;
  if (slots_ < slots_needed) {
    allocate(slots_needed);
  }

  const auto offset = static_cast<GLintptr>(next_ * slots_ * sizeof(Vec3));
  glBindBuffer(GL_COPY_WRITE_BUFFER, history_vbo_);
  if (slots_needed == count) {
    glBindBuffer(GL_COPY_READ_BUFFER, position_vbo);
    glCopyBufferSubData(GL_COPY_READ_BUFFER, GL_COPY_WRITE_BUFFER, 0, offset,
                        static_cast<GLsizeiptr>(count * sizeof(Vec3)));
  } else {
    // Compaction leaves gaps in the stable IDs. Scatter the compact VBO
    // into its original history slots so surviving particles keep their trails.
    compact_frame_.resize(count);
    frame_.resize(slots_needed);
    glBindBuffer(GL_COPY_READ_BUFFER, position_vbo);
    glGetBufferSubData(GL_COPY_READ_BUFFER, 0, static_cast<GLsizeiptr>(count * sizeof(Vec3)),
                       compact_frame_.data());
    for (std::size_t i = 0; i < count; ++i) {
      frame_.at(id_of(particles, i)) = compact_frame_.at(i);
    }
    glBufferSubData(GL_COPY_WRITE_BUFFER, offset,
                    static_cast<GLsizeiptr>(slots_needed * sizeof(Vec3)), frame_.data());
  }
  glBindBuffer(GL_COPY_READ_BUFFER, 0);
  glBindBuffer(GL_COPY_WRITE_BUFFER, 0);

  next_ = (next_ + 1) % history_;
  samples_ = std::min(samples_ + 1, history_);
  const auto oldest = (next_ + history_ - samples_) % history_;
  draw_counts_.assign(count, static_cast<int>(samples_));
  draw_offsets_.resize(count);
  for (std::size_t i = 0; i < count; ++i) {
    const auto index_offset = ((id_of(particles, i) * history_ * 2) + oldest) * sizeof(GLuint);
    draw_offsets_.at(i) = std::bit_cast<const void*>(index_offset);
  }
}

void TrailRenderer::draw(float aspect) const {
  if (samples_ < 2) {
    return;
  }
  glUseProgram(program_);
  glUniform1f(glGetUniformLocation(program_, "u_aspect"), aspect);
  glBindVertexArray(vao_);
  glMultiDrawElements(GL_LINE_STRIP, draw_counts_.data(), GL_UNSIGNED_INT, draw_offsets_.data(),
                      static_cast<GLsizei>(draw_offsets_.size()));
}

} // namespace grav
