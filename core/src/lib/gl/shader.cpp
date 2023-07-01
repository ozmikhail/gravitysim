#include "lib/gl/shader.h"

#include <glad/gl.h>

#include <array>
#include <cstdint>
#include <string>

#include "error.h"

namespace grav::gl {

namespace {

std::uint32_t compile_stage(GLenum stage, const char* source) {
    const GLuint shader = glCreateShader(stage);
    glShaderSource(shader, 1, &source, nullptr);
    glCompileShader(shader);

    GLint status = GL_FALSE;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &status);
    if (status == GL_FALSE) {
        std::array<char, 1024> log{};
        GLsizei length = 0;
        glGetShaderInfoLog(shader, static_cast<GLsizei>(log.size()), &length, log.data());
        glDeleteShader(shader);
        throw AppError::invalid_input(
            std::string("gl: shader compile failed: ") + std::string(log.data(), length)
        );
    }
    return shader;
}

}

std::uint32_t compile_program(const char* vertex_src, const char* fragment_src) {
    const GLuint vs = compile_stage(GL_VERTEX_SHADER, vertex_src);
    const GLuint fs = compile_stage(GL_FRAGMENT_SHADER, fragment_src);

    const GLuint program = glCreateProgram();
    glAttachShader(program, vs);
    glAttachShader(program, fs);
    glLinkProgram(program);

    GLint status = GL_FALSE;
    glGetProgramiv(program, GL_LINK_STATUS, &status);
    if (status == GL_FALSE) {
        std::array<char, 1024> log{};
        GLsizei length = 0;
        glGetProgramInfoLog(program, static_cast<GLsizei>(log.size()), &length, log.data());
        glDeleteShader(vs);
        glDeleteShader(fs);
        glDeleteProgram(program);
        throw AppError::invalid_input(
            std::string("gl: program link failed: ") + std::string(log.data(), length)
        );
    }

    glDeleteShader(vs);
    glDeleteShader(fs);
    return program;
}

void delete_program(std::uint32_t program) {
    if (program != 0) {
        glDeleteProgram(program);
    }
}

}
