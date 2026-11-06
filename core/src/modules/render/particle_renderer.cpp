#include "modules/render/particle_renderer.h"

#include "lib/gl/shader.h"
#include "modules/sim/particles.h"

#include <cstddef>
#include <glad/gl.h>

namespace grav {

namespace {

constexpr const char* VERTEX_SHADER = R"(#version 410 core
layout(location = 0) in vec3 a_position;
layout(location = 1) in float a_value;
uniform float u_aspect;
uniform float u_point_size;
out float v_value;
void main() {
    gl_Position = vec4(a_position.x / u_aspect, a_position.y, a_position.z, 1.0);
    gl_PointSize = u_point_size;
    v_value = a_value;
}
)";

constexpr const char* FRAGMENT_SHADER = R"(#version 410 core
in float v_value;
uniform bool u_charge_colors;
out vec4 frag_color;
void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float t = clamp(v_value * 0.5, 0.0, 1.0);
    vec3 cool = vec3(0.30, 0.55, 1.00);
    vec3 hot  = vec3(1.00, 0.70, 0.25);
    vec3 color = mix(cool, hot, t);
    if (u_charge_colors) {
        color = v_value > 0.0 ? hot : (v_value < 0.0 ? cool : vec3(0.75));
    }
    float alpha = 1.0 - (r2 * 4.0);
    frag_color = vec4(color, alpha);
}
)";

} // namespace

ParticleRenderer::ParticleRenderer(const RendererLimits& limits)
    : program_(gl::compile_program(VERTEX_SHADER, FRAGMENT_SHADER)),
      capacity_(limits.max_particles), trails_(limits.trail_history) {
  const std::size_t max_particles = limits.max_particles;
  appearance_buffer_.assign(max_particles, 0.0F);

  glGenVertexArrays(1, &vao_);
  glGenBuffers(1, &position_vbo_);
  glGenBuffers(1, &appearance_vbo_);

  glBindVertexArray(vao_);

  glBindBuffer(GL_ARRAY_BUFFER, position_vbo_);
  glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(max_particles * sizeof(Vec3)), nullptr,
               GL_DYNAMIC_DRAW);
  glEnableVertexAttribArray(0);
  glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(Vec3), nullptr);

  glBindBuffer(GL_ARRAY_BUFFER, appearance_vbo_);
  glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(max_particles * sizeof(float)), nullptr,
               GL_DYNAMIC_DRAW);
  glEnableVertexAttribArray(1);
  glVertexAttribPointer(1, 1, GL_FLOAT, GL_FALSE, sizeof(float), nullptr);

  glBindVertexArray(0);
}

ParticleRenderer::~ParticleRenderer() {
  if (position_vbo_ != 0) {
    glDeleteBuffers(1, &position_vbo_);
  }
  if (appearance_vbo_ != 0) {
    glDeleteBuffers(1, &appearance_vbo_);
  }
  if (vao_ != 0) {
    glDeleteVertexArrays(1, &vao_);
  }
  gl::delete_program(program_);
}

void ParticleRenderer::upload_positions(const Particles& particles) const {
  const std::size_t particle_count = count_particles(particles);
  if (particle_count == 0 || particle_count > capacity_) {
    return;
  }
  glBindBuffer(GL_ARRAY_BUFFER, position_vbo_);
  glBufferSubData(GL_ARRAY_BUFFER, 0, static_cast<GLsizeiptr>(particle_count * sizeof(Vec3)),
                  particles.positions.data());
}

void ParticleRenderer::upload_appearance(const Particles& particles, bool charge_colors) {
  charge_colors_ = charge_colors;
  const std::size_t particle_count = count_particles(particles);
  if (particle_count == 0 || particle_count > capacity_) {
    return;
  }
  if (appearance_buffer_.size() < particle_count) {
    appearance_buffer_.resize(particle_count);
  }
  for (std::size_t i = 0; i < particle_count; ++i) {
    appearance_buffer_.at(i) =
        charge_colors ? charge_of(particles, i) : length(particles.velocities.at(i));
  }
  glBindBuffer(GL_ARRAY_BUFFER, appearance_vbo_);
  glBufferSubData(GL_ARRAY_BUFFER, 0, static_cast<GLsizeiptr>(particle_count * sizeof(float)),
                  appearance_buffer_.data());
}

void ParticleRenderer::draw(FramebufferSize framebuffer, std::size_t count) {
  const int framebuffer_width = framebuffer.width;
  const int framebuffer_height = framebuffer.height;
  if (count == 0) {
    return;
  }
  const float aspect = framebuffer_height > 0 ? static_cast<float>(framebuffer_width) /
                                                    static_cast<float>(framebuffer_height)
                                              : 1.0F;
  const auto fb_w = static_cast<float>(framebuffer_width);
  const float point_size = (fb_w / 1600.0F) * 3.5F;

  glEnable(GL_PROGRAM_POINT_SIZE);
  glEnable(GL_BLEND);
  glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

  trails_.draw(aspect);

  glUseProgram(program_);
  glUniform1f(glGetUniformLocation(program_, "u_aspect"), aspect);
  glUniform1f(glGetUniformLocation(program_, "u_point_size"), point_size);
  glUniform1i(glGetUniformLocation(program_, "u_charge_colors"), charge_colors_ ? 1 : 0);

  glBindVertexArray(vao_);
  glDrawArrays(GL_POINTS, 0, static_cast<GLsizei>(count));
  glBindVertexArray(0);
  glUseProgram(0);

  glDisable(GL_BLEND);
}

} // namespace grav
