#include "modules/render/trail_renderer.h"

#include <glad/gl.h>

#include <algorithm>

#include "lib/gl/gl.h"
#include "lib/gl/shader.h"
#include "modules/sim/particles.h"

namespace grav {

namespace {

constexpr const char* kVertexShader = R"(#version 410 core
layout(location = 0) in vec3 a_position;
uniform float u_aspect;
void main() {
    gl_Position = vec4(a_position.x / u_aspect, a_position.yz, 1.0);
}
)";

constexpr const char* kFragmentShader = R"(#version 410 core
out vec4 frag_color;
void main() {
    frag_color = vec4(0.30, 0.55, 1.0, 0.14);
}
)";

}

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
        program_ = gl::compile_program(kVertexShader, kFragmentShader);
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
            const auto vertex = static_cast<GLuint>(sample * slots_ + slot);
            indices[base + sample] = vertex;
            indices[base + history_ + sample] = vertex;
        }
    }
    draw_counts_.resize(slots_);
    draw_offsets_.resize(slots_);

    glBindVertexArray(vao_);
    glBindBuffer(GL_ARRAY_BUFFER, history_vbo_);
    glBufferData(GL_ARRAY_BUFFER, slots_ * history_ * sizeof(Vec3), nullptr, GL_DYNAMIC_COPY);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(Vec3), nullptr);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, index_buffer_);
    glBufferData(
        GL_ELEMENT_ARRAY_BUFFER, indices.size() * sizeof(GLuint), indices.data(), GL_STATIC_DRAW
    );
    glBindVertexArray(0);
    gl::check("allocate trail history");
}

void TrailRenderer::record(std::uint32_t position_vbo, std::size_t count) {
    if (history_ < 2 || count == 0) {
        return;
    }
    if (slots_ != count) {
        allocate(count);
    }

    const auto frame_bytes = slots_ * sizeof(Vec3);
    glBindBuffer(GL_COPY_READ_BUFFER, position_vbo);
    glBindBuffer(GL_COPY_WRITE_BUFFER, history_vbo_);
    glCopyBufferSubData(GL_COPY_READ_BUFFER, GL_COPY_WRITE_BUFFER, 0, next_ * frame_bytes, frame_bytes);
    glBindBuffer(GL_COPY_READ_BUFFER, 0);
    glBindBuffer(GL_COPY_WRITE_BUFFER, 0);

    next_ = (next_ + 1) % history_;
    samples_ = std::min(samples_ + 1, history_);
    const auto oldest = (next_ + history_ - samples_) % history_;
    std::fill(draw_counts_.begin(), draw_counts_.end(), static_cast<GLsizei>(samples_));
    for (std::size_t slot = 0; slot < slots_; ++slot) {
        const auto offset = (slot * history_ * 2 + oldest) * sizeof(GLuint);
        draw_offsets_[slot] = reinterpret_cast<const void*>(offset);
    }
}

void TrailRenderer::draw(float aspect) const {
    if (samples_ < 2) {
        return;
    }
    glUseProgram(program_);
    glUniform1f(glGetUniformLocation(program_, "u_aspect"), aspect);
    glBindVertexArray(vao_);
    glMultiDrawElements(
        GL_LINE_STRIP, draw_counts_.data(), GL_UNSIGNED_INT, draw_offsets_.data(),
        static_cast<GLsizei>(slots_)
    );
}

}
