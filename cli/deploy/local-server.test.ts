import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { UserError } from "../errors.ts"
import { checkLocalDeployPaths, localDockerEndpointProblem } from "./local-server.ts"

const PROJECT = "/home/user/code/homelab"

Deno.test("checkLocalDeployPaths: PATH_APPS equal to the project folder is refused", () => {
  const err = assertThrows(
    () =>
      checkLocalDeployPaths({
        projectRoots: [PROJECT],
        pathApps: PROJECT,
        volumesPath: "/srv/volumes",
      }),
    UserError,
  )
  assertStringIncludes(err.message, "PATH_APPS")
})

Deno.test("checkLocalDeployPaths: PATH_APPS inside or above the project folder is refused", () => {
  for (const pathApps of [`${PROJECT}/apps`, "/home/user/code"]) {
    assertThrows(
      () => checkLocalDeployPaths({ projectRoots: [PROJECT], pathApps, volumesPath: "/srv/v" }),
      UserError,
      "overlaps the project folder",
    )
  }
})

Deno.test("checkLocalDeployPaths: VOLUMES_PATH inside the project folder is refused", () => {
  assertThrows(
    () =>
      checkLocalDeployPaths({
        projectRoots: [PROJECT],
        pathApps: "/srv/apps",
        volumesPath: `${PROJECT}/volumes`,
      }),
    UserError,
    "VOLUMES_PATH",
  )
})

Deno.test("checkLocalDeployPaths: PATH_APPS equal to HOME or one of its parents is refused", () => {
  for (const pathApps of ["/home/user", "/home"]) {
    assertThrows(
      () =>
        checkLocalDeployPaths({
          projectRoots: ["/opt/homelab"],
          pathApps,
          volumesPath: "/srv/volumes",
          home: "/home/user",
        }),
      UserError,
      "home folder",
    )
  }
})

Deno.test("checkLocalDeployPaths: sibling folders outside the project and inside HOME pass", () => {
  checkLocalDeployPaths({
    projectRoots: [PROJECT],
    pathApps: "/home/user/apps",
    volumesPath: "/home/user/volumes",
    home: "/home/user",
  })
})

Deno.test("localDockerEndpointProblem: a DOCKER_HOST that isn't a unix socket is named", () => {
  assertStringIncludes(
    localDockerEndpointProblem("tcp://192.0.2.1:2375", "unix:///var/run/docker.sock") ?? "",
    `DOCKER_HOST is "tcp://192.0.2.1:2375"`,
  )
  assertStringIncludes(
    localDockerEndpointProblem("ssh://root@192.0.2.1", "unix:///var/run/docker.sock") ?? "",
    "ssh://root@192.0.2.1",
  )
})

Deno.test("localDockerEndpointProblem: an active docker context pointing elsewhere is named", () => {
  assertStringIncludes(
    localDockerEndpointProblem(undefined, "ssh://deploy@prod.example.com") ?? "",
    `context points at "ssh://deploy@prod.example.com"`,
  )
})

Deno.test("localDockerEndpointProblem: an endpoint docker can't report is refused", () => {
  assertEquals(typeof localDockerEndpointProblem(undefined, undefined), "string")
})

Deno.test("localDockerEndpointProblem: local unix sockets pass, rootless included", () => {
  assertEquals(localDockerEndpointProblem(undefined, "unix:///var/run/docker.sock"), undefined)
  assertEquals(
    localDockerEndpointProblem(
      "unix:///run/user/1000/docker.sock",
      "unix:///run/user/1000/docker.sock",
    ),
    undefined,
  )
})
