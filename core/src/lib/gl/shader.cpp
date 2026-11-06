#include "lib/gl/shader.h"

#include "error.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <glad/gl.h>
#include <string>

namespace grav::gl {

namespace {

constexpr std::size_t INFO_LOG_SIZE = 1024;

std::uint32_t compile_stage(GLenum stage, const char* source) {
  const GLuint shader = glCreateShader(stage);
  glShaderSource(shader, 1, &source, nullptr);
  glCompileShader(shader);

  GLint status = GL_FALSE;
  glGetShaderiv(shader, GL_COMPILE_STATUS, &status);
  if (status == GL_FALSE) {
    std::array<char, INFO_LOG_SIZE> log{};
    GLsizei length = 0;
    glGetShaderInfoLog(shader, static_cast<GLsizei>(log.size()), &length, log.data());
    glDeleteShader(shader);
    throw AppError::invalid_input(std::string("gl: shader compile failed: ") +
                                  std::string(log.data(), length));
  }
  return shader;
}

} // namespace

std::uint32_t compile_program(const char* vertex_src, const char* fragment_src) {
  const GLuint vertex_shader = compile_stage(GL_VERTEX_SHADER, vertex_src);
  const GLuint fragment_shader = compile_stage(GL_FRAGMENT_SHADER, fragment_src);

  const GLuint program = glCreateProgram();
  glAttachShader(program, vertex_shader);
  glAttachShader(program, fragment_shader);
  glLinkProgram(program);

  GLint status = GL_FALSE;
  glGetProgramiv(program, GL_LINK_STATUS, &status);
  if (status == GL_FALSE) {
    std::array<char, INFO_LOG_SIZE> log{};
    GLsizei length = 0;
    glGetProgramInfoLog(program, static_cast<GLsizei>(log.size()), &length, log.data());
    glDeleteShader(vertex_shader);
    glDeleteShader(fragment_shader);
    glDeleteProgram(program);
    throw AppError::invalid_input(std::string("gl: program link failed: ") +
                                  std::string(log.data(), length));
  }

  glDeleteShader(vertex_shader);
  glDeleteShader(fragment_shader);
  return program;
}

void delete_program(std::uint32_t program) {
  if (program != 0) {
    glDeleteProgram(program);
  }
}

} // namespace grav::gl
