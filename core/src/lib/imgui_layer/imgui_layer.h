#pragma once

struct GLFWwindow;

namespace grav::imgui {

class Session {
public:
    Session(GLFWwindow* window, float dpi_scale);
    ~Session();

    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;
    Session(Session&&) = delete;
    Session& operator=(Session&&) = delete;
};

void begin_frame();
void end_frame();

}
