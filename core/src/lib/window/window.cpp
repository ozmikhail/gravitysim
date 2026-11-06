#include "lib/window/window.h"

#include "error.h"

#include <GLFW/glfw3.h>
#include <mutex>
#include <string>
#include <utility>

namespace grav {

namespace {

std::mutex& init_guard() {
  static std::mutex guard;
  return guard;
}

int& init_count() {
  static int count = 0;
  return count;
}

std::string& last_error() {
  thread_local std::string error;
  return error;
}

void glfw_error_callback(int code, const char* description) {
  std::string& error = last_error();
  error.assign("glfw error ");
  error += std::to_string(code);
  if (description != nullptr) {
    error += ": ";
    error += description;
  }
}

void glfw_init_once() {
  const std::scoped_lock lock(init_guard());
  if (init_count() == 0) {
    glfwSetErrorCallback(&glfw_error_callback);
    if (glfwInit() != GLFW_TRUE) {
      const std::string msg = std::string("glfw: init failed: ") + last_error();
      throw AppError::dependency_unavailable(msg);
    }
  }
  ++init_count();
}

void glfw_terminate_once() {
  const std::scoped_lock lock(init_guard());
  if (init_count() == 0) {
    return;
  }
  --init_count();
  if (init_count() == 0) {
    glfwTerminate();
  }
}

GLFWwindow* create_window(const Window::Config& cfg) {
  glfw_init_once();

  glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, cfg.gl_major);
  glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, cfg.gl_minor);
  glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
  glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GLFW_TRUE);
  glfwWindowHint(GLFW_RESIZABLE, GLFW_TRUE);
#ifdef __APPLE__
  glfwWindowHint(GLFW_COCOA_RETINA_FRAMEBUFFER, GLFW_TRUE);
#endif

  GLFWwindow* handle = glfwCreateWindow(cfg.width, cfg.height, cfg.title.c_str(), nullptr, nullptr);
  if (handle == nullptr) {
    const std::string msg = std::string("glfw: window creation failed: ") + last_error();
    glfw_terminate_once();
    throw AppError::dependency_unavailable(msg);
  }

  glfwMakeContextCurrent(handle);
  glfwSwapInterval(cfg.vsync ? 1 : 0);
  return handle;
}

} // namespace

Window::Window(const Config& cfg) : handle_(create_window(cfg)) {}

Window::~Window() {
  if (handle_ != nullptr) {
    glfwDestroyWindow(handle_);
    handle_ = nullptr;
  }
  glfw_terminate_once();
}

bool Window::should_close() const { return glfwWindowShouldClose(handle_) == GLFW_TRUE; }

void Window::poll_events() { glfwPollEvents(); }

void Window::swap_buffers() { glfwSwapBuffers(handle_); }

std::pair<int, int> Window::framebuffer_size() const {
  int width = 0;
  int height = 0;
  glfwGetFramebufferSize(handle_, &width, &height);
  return {width, height};
}

std::pair<int, int> Window::window_size() const {
  int width = 0;
  int height = 0;
  glfwGetWindowSize(handle_, &width, &height);
  return {width, height};
}

float Window::dpi_scale() const {
  const auto [fb_w, fb_h] = framebuffer_size();
  const auto [wn_w, wn_h] = window_size();
  if (wn_w <= 0) {
    return 1.0F;
  }
  return static_cast<float>(fb_w) / static_cast<float>(wn_w);
}

} // namespace grav
