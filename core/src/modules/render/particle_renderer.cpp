#include "modules/render/particle_renderer.h"

#include <glad/gl.h>

#include <cstddef>

#include "lib/gl/shader.h"
#include "modules/sim/particles.h"

namespace grav {

namespace {

constexpr const char* kVertexShader = R"(#version 410 core
layout(location = 0) in vec3 a_position;
layout(location = 1) in float a_speed;
uniform float u_aspect;
uniform float u_point_size;
out float v_speed;
void main() {
    gl_Position = vec4(a_position.x / u_aspect, a_position.y, a_position.z, 1.0);
    gl_PointSize = u_point_size;
    v_speed = a_speed;
}
)";

constexpr const char* kFragmentShader = R"(#version 410 core
in float v_speed;
out vec4 frag_color;
void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float t = clamp(v_speed * 0.5, 0.0, 1.0);
    vec3 cool = vec3(0.30, 0.55, 1.00);
    vec3 hot  = vec3(1.00, 0.70, 0.25);
    vec3 color = mix(cool, hot, t);
    float alpha = 1.0 - (r2 * 4.0);
    frag_color = vec4(color, alpha);
}
)";

}

ParticleRenderer::ParticleRenderer(std::size_t max_particles, std::size_t trail_history)
    : capacity_(max_particles), trails_(trail_history) {
    program_ = gl::compile_program(kVertexShader, kFragmentShader);
    speed_buffer_.assign(max_particles, 0.0F);

    glGenVertexArrays(1, &vao_);
    glGenBuffers(1, &position_vbo_);
    glGenBuffers(1, &speed_vbo_);

    glBindVertexArray(vao_);

    glBindBuffer(GL_ARRAY_BUFFER, position_vbo_);
    glBufferData(
        GL_ARRAY_BUFFER,
        static_cast<GLsizeiptr>(max_particles * sizeof(Vec3)),
        nullptr,
        GL_DYNAMIC_DRAW
    );
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(Vec3), nullptr);

    glBindBuffer(GL_ARRAY_BUFFER, speed_vbo_);
    glBufferData(
        GL_ARRAY_BUFFER,
        static_cast<GLsizeiptr>(max_particles * sizeof(float)),
        nullptr,
        GL_DYNAMIC_DRAW
    );
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 1, GL_FLOAT, GL_FALSE, sizeof(float), nullptr);

    glBindVertexArray(0);
}

ParticleRenderer::~ParticleRenderer() {
    if (position_vbo_ != 0) {
        glDeleteBuffers(1, &position_vbo_);
    }
    if (speed_vbo_ != 0) {
        glDeleteBuffers(1, &speed_vbo_);
    }
    if (vao_ != 0) {
        glDeleteVertexArrays(1, &vao_);
    }
    gl::delete_program(program_);
}

void ParticleRenderer::upload_positions(const Particles& particles) {
    const std::size_t n = particles.count();
    if (n == 0 || n > capacity_) {
        return;
    }
    glBindBuffer(GL_ARRAY_BUFFER, position_vbo_);
    glBufferSubData(
        GL_ARRAY_BUFFER,
        0,
        static_cast<GLsizeiptr>(n * sizeof(Vec3)),
        particles.positions.data()
    );
}

void ParticleRenderer::upload_speeds(const Particles& particles) {
    const std::size_t n = particles.count();
    if (n == 0 || n > capacity_) {
        return;
    }
    if (speed_buffer_.size() < n) {
        speed_buffer_.resize(n);
    }
    for (std::size_t i = 0; i < n; ++i) {
        speed_buffer_[i] = length(particles.velocities[i]);
    }
    glBindBuffer(GL_ARRAY_BUFFER, speed_vbo_);
    glBufferSubData(
        GL_ARRAY_BUFFER,
        0,
        static_cast<GLsizeiptr>(n * sizeof(float)),
        speed_buffer_.data()
    );
}

void ParticleRenderer::draw(int framebuffer_width, int framebuffer_height, std::size_t count) {
    if (count == 0) {
        return;
    }
    const float aspect =
        framebuffer_height > 0
            ? static_cast<float>(framebuffer_width) / static_cast<float>(framebuffer_height)
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

    glBindVertexArray(vao_);
    glDrawArrays(GL_POINTS, 0, static_cast<GLsizei>(count));
    glBindVertexArray(0);
    glUseProgram(0);

    glDisable(GL_BLEND);
}

}
