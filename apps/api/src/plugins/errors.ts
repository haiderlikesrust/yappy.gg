import fp from 'fastify-plugin';
import type { FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ErrorCode } from '@yappy/shared';
import { isProd } from '../env.js';

/**
 * One error shape for the entire API: `{ error: { code, message, details? } }`.
 *
 * Clients switch on `code`. Nothing else about an error is contractual.
 */
export const errorsPlugin = fp(async (app) => {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfter !== undefined) reply.header('Retry-After', String(err.retryAfter));
      if (err.status >= 500) req.log.error({ err }, 'application error');
      return reply.status(err.status).send(err.toBody());
    }

    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: ErrorCode.ValidationFailed,
          message: 'Request validation failed',
          details: err.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        },
      });
    }

    // Fastify's own validation / parsing errors.
    const statusCode = (err as FastifyError).statusCode;
    if (typeof statusCode === 'number' && statusCode < 500) {
      return reply.status(statusCode).send({
        error: { code: ErrorCode.BadRequest, message: err.message },
      });
    }

    // Postgres unique violation surfacing as a 500 is almost always a missing
    // conflict branch in a handler — worth the loud log.
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') {
      req.log.warn({ err }, 'unhandled unique violation');
      return reply.status(409).send({
        error: { code: ErrorCode.AlreadyExists, message: 'That already exists' },
      });
    }
    if (pgCode === '23503') {
      return reply.status(400).send({
        error: { code: ErrorCode.BadRequest, message: 'Referenced record does not exist' },
      });
    }

    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: {
        code: ErrorCode.Internal,
        message: isProd ? 'Something went wrong' : err.message,
      },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: { code: ErrorCode.NotFound, message: `No route for ${req.method} ${req.url}` },
    }),
  );
});
