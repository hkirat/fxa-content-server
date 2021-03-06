/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

define(function (require, exports, module) {
  'use strict';

  const _ = require('underscore');
  const $ = require('jquery');
  const { assert } = require('chai');
  const AuthErrors = require('lib/auth-errors');
  const Backbone = require('backbone');
  const BaseBroker = require('models/auth_brokers/base');
  const BaseView = require('views/base');
  const DOMEventMock = require('../../mocks/dom-event');
  const ErrorUtils = require('lib/error-utils');
  const Metrics = require('lib/metrics');
  const Notifier = require('lib/channels/notifier');
  const p = require('lib/promise');
  const Relier = require('models/reliers/base');
  const sinon = require('sinon');
  const Template = require('stache!templates/test_template');
  const TestHelpers = require('../../lib/helpers');
  const Translator = require('lib/translator');
  const User = require('models/user');
  const VerificationReasons = require('lib/verification-reasons');
  const VerificationMethods = require('lib/verification-methods');
  const WindowMock = require('../../mocks/window');

  const { requiresFocus, wrapAssertion } = TestHelpers;

  describe('views/base', function () {
    let broker;
    let metrics;
    let model;
    let notifier;
    let relier;
    let translator;
    let user;
    let view;
    let viewName = 'view';
    let windowMock;

    const View = BaseView.extend({
      events: {
        'click #required': '_onRequiredClick'
      },
      layoutClassName: 'layout',
      template: Template,
      context: function () {
        return {
          error: this.model.get('templateWrittenError'),
          success: this.model.get('templateWrittenSuccess')
        };
      },

      _onRequiredClick () {
        // intentionally left empty, a spy is attached.
      }
    });

    const HTML_MESSAGE = '<span>html</span>';
    const UNESCAPED_HTML_TRANSLATION = '<span>translated html</span>';
    const ESCAPED_HTML_TRANSLATION = _.escape(UNESCAPED_HTML_TRANSLATION);
    const UNSAFE_INTERPOLATION_VARIABLE = '%(unsafeInterpolationVariable)s';

    beforeEach(function () {
      translator = new Translator('en-US', ['en-US']);
      translator.set({
        'another message': 'another translated message',
        'the error message': 'a translated error message',
        'the success message': 'a translated success message',
        [HTML_MESSAGE]: UNESCAPED_HTML_TRANSLATION,
        [UNSAFE_INTERPOLATION_VARIABLE]: UNSAFE_INTERPOLATION_VARIABLE
      });

      broker = new BaseBroker();
      model = new Backbone.Model();
      notifier = new Notifier();
      metrics = new Metrics({
        notifier,
        sentryMetrics: {
          captureException () {}
        }
      });
      relier = new Relier();
      user = new User();
      windowMock = new WindowMock();

      view = new View({
        broker: broker,
        metrics: metrics,
        model: model,
        notifier: notifier,
        relier: relier,
        translator: translator,
        user: user,
        viewName: viewName,
        window: windowMock
      });

      $(windowMock.document.body).attr('data-flow-id', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
      $(windowMock.document.body).attr('data-flow-begin', Date.now());
      notifier.trigger('flow.initialize');

      return view.render();
    });

    afterEach(function () {
      metrics.destroy();

      if (view) {
        view.destroy();
        $('#container').empty();
      }

      view = windowMock = metrics = null;
    });

    describe('renderTemplate', () => {
      it('invokes the template with merged `context` and `additionalContext`', () => {
        const template = sinon.spy();
        const additionalContext = {
          baz: 'buz'
        };
        sinon.stub(view, 'getContext', () => {
          return { foo: 'bar' };
        });

        view.renderTemplate(template, additionalContext);

        assert.isTrue(template.calledOnce);
        assert.isTrue(template.calledWith({ baz: 'buz', foo: 'bar' }));
      });
    });

    describe('render', function () {
      it('adds the `layoutClassName` to the body', function () {
        assert.isTrue($('body').hasClass('layout'));
      });

      it('triggers the `rendered` message when complete', function () {
        var deferred = p.defer();

        view.on('rendered', deferred.resolve.bind(deferred));
        view.render();

        return deferred.promise;
      });

      it('updates the page title with the embedded h1 and h2 tags', function () {
        view.template = function () {
          return '<header><h1>Main title</h1><h2>Sub title</h2></header>';
        };
        return view.render()
            .then(function () {
              $('#container').html(view.el);
              assert.equal(view.titleFromView(), 'Main title: Sub title');
            });
      });


      it('updates the page title with the embedded h2 tag and base title', function () {
        view.template = function () {
          return '<header><h2>Sub title</h2></header>';
        };
        return view.render()
            .then(function () {
              assert.equal(view.titleFromView('Base title'), 'Base title: Sub title');
            });
      });

      it('updates the page title with the embedded h1 tag if no h2 tag', function () {
        view.template = function () {
          return '<header><h1>Title only</h1></header><header><h2>Not in first header</h2></header>';
        };
        return view.render()
            .then(function () {
              assert.equal(view.titleFromView(), 'Title only');
            });
      });

      it('updates the page title with the startup page title if no h1 or h2 tag', function () {
        view.template = function () {
          return '<div>no titles anywhere</div>';
        };
        return view.render()
            .then(function () {
              assert.equal(view.titleFromView(), 'Firefox Accounts Unit Tests');
            });
      });

      it('does not render if the view has already navigated', () => {
        sinon.spy(view, 'renderTemplate');
        sinon.spy(view, 'navigate');
        sinon.stub(view, 'beforeRender', function () {
          this.navigate('signin');
        });

        return view.render()
          .then(() => {
            assert.isTrue(view.navigate.called);
            assert.isFalse(view.renderTemplate.called);
          });
      });

      it('redirects to `/signin` if the user is not authenticated', function () {
        sinon.stub(user, 'sessionStatus', () => p.reject(AuthErrors.toError('INVALID_TOKEN')));
        sinon.spy(view, 'navigate');

        view.mustAuth = true;
        return view.render()
          .then(function (result) {
            assert.isFalse(result);
            assert.isTrue(view.navigate.calledWith('signin'));
            assert.isTrue(TestHelpers.isErrorLogged(metrics,
              AuthErrors.toError('SESSION_EXPIRED', viewName)), 'Session expired error logged');
            assert.equal(view.$('.error').html(), '', 'Session expired error not visible to the user');
          });
      });

      it('redirects to `/force_auth` if the user is not authenticated and the relier specifies an email', function () {
        relier.set('email', 'a@a.com');

        sinon.stub(user, 'sessionStatus', () => p.reject(AuthErrors.toError('INVALID_TOKEN')));
        sinon.spy(view, 'navigate');

        view.mustAuth = true;
        return view.render()
          .then(function (result) {
            assert.isFalse(result);
            assert.isTrue(view.navigate.calledWith('force_auth'));
            assert.isTrue(TestHelpers.isErrorLogged(metrics,
              AuthErrors.toError('SESSION_EXPIRED', viewName)), 'Session expired error logged');
            assert.equal(view.$('.error').html(), '', 'Session expired error not visible to the user');
          });
      });

      it('redirects to `/confirm` if mustVerify flag is set and account is unverified', function () {
        view.mustVerify = true;
        const account = user.initAccount({
          email: 'a@a.com',
          sessionToken: 'abc123',
          uid: 'uid',
          verificationMethod: VerificationMethods.EMAIL,
          verificationReason: VerificationReasons.SIGN_UP,
          verified: false
        });
        sinon.stub(user, 'sessionStatus', () => p(account));

        sinon.spy(view, 'navigate');
        return view.render()
          .then(function () {
            assert.isTrue(view.navigate.calledWith('confirm'));
          });
      });

      it('redirects to `/confirm_signin` if mustVerify flag is set and session is unverified', function () {
        view.mustVerify = true;
        const account = user.initAccount({
          email: 'a@a.com',
          sessionToken: 'abc123',
          uid: 'uid',
          verificationMethod: VerificationMethods.EMAIL,
          verificationReason: VerificationReasons.SIGN_IN,
          verified: false
        });
        sinon.stub(user, 'sessionStatus', () => p(account));

        sinon.spy(view, 'navigate');
        return view.render()
          .then(function () {
            assert.isTrue(view.navigate.calledWith('confirm_signin'));
          });
      });

      it('succeeds if mustVerify flag is set and account has verified since being stored', function () {
        view.mustVerify = true;
        const account = user.initAccount({
          email: 'a@a.com',
          sessionToken: 'abc123',
          uid: 'uid'
        });
        sinon.stub(user, 'sessionStatus', () => {
          account.set('verified', true);
          return p(account);
        });

        return view.render()
          .then(function (result) {
            assert.isTrue(result);
          });
      });

      it('succeeds if mustVerify flag is set and account is verified', function () {
        view.mustVerify = true;
        var account = user.initAccount({
          email: 'a@a.com',
          sessionToken: 'abc123',
          uid: 'uid',
          verified: true
        });
        sinon.stub(user, 'sessionStatus', () => p(account));

        return view.render()
          .then(function (result) {
            assert.isTrue(result);
          });
      });

      describe('with an error message written from the template', () => {
        beforeEach(() => {
          model.set('templateWrittenError', 'error written from the template');
          return view.render();
        });

        it('displays the message, `isErrorVisible` returns `true`', () => {
          assert.isTrue(view.isErrorVisible());
        });
      });

      describe('with a success message written from the template', () => {
        beforeEach(() => {
          model.set('templateWrittenSuccess', 'success written from the template');
          return view.render();
        });

        it('displays the message, `isSuccessVisible` returns `true`', () => {
          assert.isTrue(view.isSuccessVisible());
        });
      });
    });

    describe('afterVisible', function () {
      afterEach(function () {
        $('html').removeClass('no-touch');
      });

      it('shows success messages', function () {
        model.set('success', 'success message');
        view.afterVisible();
        assert.equal(view.$('.success').text(), 'success message');
      });

      it('shows error messages', function () {
        model.set('error', 'error message');
        view.afterVisible();
        assert.equal(view.$('.error').text(), 'error message');
      });

      it('adds `centered` class to `.links` if any child has width >= half of `.links` width', function () {
        var link1 = '<a href="/reset_password" class="left reset-password">Forgot password?</a>';
        var link2 = '<a href="/signup" class="right sign-up">Create an account with really really looooooooooooooong text</a>';
        $('#container').html(view.el);
        $('.links').html(link1 + link2);
        // force the width to be 50%
        $('.links > .right').css({'display': 'inline-block', 'width': '50%'});
        view.afterVisible();
        assert.isTrue($('.links').hasClass('centered'));
      });

      it('does not add `centered` class to `.links` if all children have width < half of `.links` width', function () {
        var link1 = '<a href="/reset_password" class="left reset-password">Forgot password?</a>';
        var link2 = '<a href="/signup" class="right sign-up">Create an account</a>';
        $('#container').html(view.el);
        $('.links').html(link1 + link2);
        // force the widths of all children to be less than 50%
        $('.links').children().css({'display': 'inline-block', 'width': '49%'});
        view.afterVisible();
        assert.isFalse($('.links').hasClass('centered'));
      });

      it('focuses descendent element containing `autofocus` if html has `no-touch` class', function (done) {
        requiresFocus(function () {
          $('#container').html(view.el);
          $('html').addClass('no-touch');
          // webkit fails unless focusing another element first.
          $('#otherElement').focus();

          $('#focusMe').on('focus', () => done());

          view.afterVisible();
        }, done);
      });

      it('does not focus descendent element containing `autofocus` if html does not have `no-touch` class', function (done) {
        requiresFocus(function () {
          var handlerCalled = false;
          $('#focusMe').on('focus', function () {
            handlerCalled = true;
          });

          // IE focuses the elements asynchronously.
          // Add a bit of delay to give the browser time to focus
          // the element, if it erroneously does so.
          setTimeout(function () {
            assert.isFalse(handlerCalled);
            done();
          }, 200);

          view.afterVisible();
        }, done);
      });
    });

    describe('destroy', function () {
      it('destroys the view, any childViews, stops listening for messages, and triggers `destroy` and `destroyed` messages', function () {
        sinon.spy(view, 'trigger');
        sinon.spy(view, 'destroyChildViews');
        view.beforeDestroy = sinon.spy();

        view.destroy();

        assert.isTrue(view.beforeDestroy.called);
        assert.isTrue(view.trigger.calledWith('destroy'));
        assert.isTrue(view.trigger.calledWith('destroyed'));
        assert.isTrue(view.destroyChildViews.called);

        assert.isFalse($('body').hasClass('layout'));
      });
    });

    describe('translate', function () {
      it('translates a message, if a translation is available, does not log', function () {
        sinon.spy(view, 'logError');

        assert.equal(view.translate('no translation'), 'no translation');
        assert.equal(view.translate('another message'), 'another translated message');
        assert.isFalse(view.logError.called);
      });

      it('escapes HTML strings, logs an error', () => {
        sinon.spy(view, 'logError');
        assert.equal(view.translate(HTML_MESSAGE), ESCAPED_HTML_TRANSLATION);
        assert.isTrue(view.logError.calledOnce);
        assert.isTrue(
          AuthErrors.is(view.logError.args[0][0], 'HTML_WILL_BE_ESCAPED'));
      });
    });

    describe('unsafeTranslate', () => {
      it('does not escape, logs error if variable names lack `escaped` prefix', () => {
        sinon.spy(view, 'logError');

        assert.equal(
          view.unsafeTranslate(HTML_MESSAGE), UNESCAPED_HTML_TRANSLATION);
        assert.isFalse(view.logError.called);

        view.unsafeTranslate(UNSAFE_INTERPOLATION_VARIABLE);
        assert.isTrue(view.logError.calledOnce);
        assert.isTrue(
          AuthErrors.is(view.logError.args[0][0], 'UNSAFE_INTERPOLATION_VARIABLE_NAME'));
      });
    });

    describe('translateInTemplate', function () {
      describe('returns a function that can by used by Handlebars to do translation', function () {
        it('can be bound to a string on creation', function () {
          var translationFunc = view.translateInTemplate('another message');

          assert.equal(translationFunc(), 'another translated message');
        });

        it('returned function can be passed a string at runtime', function () {
          var translationFunc = view.translateInTemplate();

          assert.equal(translationFunc('another message'), 'another translated message');
        });
      });
    });

    describe('unsafeTranslateInTemplate', function () {
      describe('returns a function that can by used by Handlebars to do translation', function () {
        it('can be bound to a string on creation', function () {
          var translationFunc = view.unsafeTranslateInTemplate(HTML_MESSAGE);

          assert.equal(translationFunc(), UNESCAPED_HTML_TRANSLATION);
        });

        it('returned function can be passed a string at runtime', function () {
          var translationFunc = view.unsafeTranslateInTemplate();

          assert.equal(translationFunc(HTML_MESSAGE), UNESCAPED_HTML_TRANSLATION);
        });
      });
    });

    describe('writeToDOM', function () {
      var content = '<div id="stage-child">stage child content</div>';
      beforeEach(function () {
        $('#container').html('<div id="stage">stage content</div>');
      });

      describe('with text', function () {
        beforeEach(function () {
          view.writeToDOM(content);
        });

        it('overwrite #stage with the html', function () {
          assert.notInclude($('#stage').html(), 'stage content');
          assert.include($('#stage').html(), 'stage child content');
        });
      });

      describe('with a jQuery element', function () {
        beforeEach(function () {
          view.writeToDOM($(content));
        });

        it('overwrite #stage with the html', function () {
          assert.notInclude($('#stage').html(), 'stage content');
          assert.include($('#stage').html(), 'stage child content');
        });
      });
    });

    describe('displayError/isErrorVisible/hideError', function () {
      it('translates and display an error in the .error element', function () {
        var msg = view.displayError('the error message');
        var expected = 'a translated error message';
        assert.equal(view.$('.error').html(), expected);
        assert.equal(msg, expected);

        assert.isTrue(view.isErrorVisible());
        view.hideError();
        assert.isFalse(view.isErrorVisible());
      });

      it('logError is called for error', function () {
        var error = AuthErrors.toError('UNEXPECTED_ERROR');
        sinon.spy(view, 'logError');
        view.displayError(error);
        assert.isTrue(view.logError.called);
        assert.isTrue(error.logged);
      });

      it('does not log an already logged error', function () {
        var error = AuthErrors.toError('UNEXPECTED_ERROR');
        error.logged = true;
        sinon.stub(metrics, 'logError', function () { });
        view.displayError(error);
        assert.isFalse(metrics.logError.called);
      });

      it('hides any previously displayed success messages', function () {
        view.displaySuccess('the success message');
        view.displayError('the error message');
        assert.isTrue(view.isErrorVisible());
        assert.isFalse(view.isSuccessVisible());
      });

      it('removes HTML from error messages', function () {
        view.displayError('an error message<div>with html</div>');
        assert.equal(view.$('.error').html(), 'an error message&lt;div&gt;with html&lt;/div&gt;');
      });

      it('adds an entry into the event stream', function () {
        var err = AuthErrors.toError('INVALID_TOKEN', viewName);
        view.displayError(err);

        assert.isTrue(TestHelpers.isErrorLogged(metrics, err));
      });

      it('displays an `Unexpected Error` if error is unknown', function () {
        view.displayError({ errno: -10001 });
        assert.equal(view.$('.error').html(), AuthErrors.toMessage('UNEXPECTED_ERROR'));
      });

      it('displays an `Unexpected Error` if no error passed in', function () {
        view.displayError();
        assert.equal(view.$('.error').html(), AuthErrors.toMessage('UNEXPECTED_ERROR'));
      });

      it('does not log or display an error after window.beforeunload', function () {
        view.$('.error').html('');

        $(windowMock).trigger('beforeunload');
        view.displayError(AuthErrors.toError('UNEXPECTED_ERROR'));

        assert.equal(view.$('.error').html(), '');
      });

      it('`hideError` removes `.visible` from displayed messages', () => {
        view.$('.error').addClass('.visible').html('synthesized error written via template');
        view.hideError();
        assert.isFalse(view.$('.error').hasClass('visible'));
      });
    });

    describe('unsafeDisplayError', function () {
      it('allows HTML in error messages', function () {
        var msg = view.unsafeDisplayError('an error message<div>with html</div>');
        var expected = 'an error message<div>with html</div>';
        assert.equal(view.$('.error').html(), expected);
        assert.equal(msg, expected);

        assert.isTrue(view.isErrorVisible());
        view.hideError();
        assert.isFalse(view.isErrorVisible());
      });

      it('adds an entry into the event stream', function () {
        var err = AuthErrors.toError('INVALID_TOKEN', viewName);

        view.displayError(err);

        assert.isTrue(TestHelpers.isErrorLogged(metrics, err));
      });

      it('displays an `Unexpected Error` if no error passed in', function () {
        view.displayError();
        assert.equal(view.$('.error').html(), AuthErrors.toMessage('UNEXPECTED_ERROR'));
      });
    });

    describe('displaySuccess/isSuccessVisible/hideSuccess', function () {
      it('translates and display an success in the .success element', function () {
        view.displaySuccess('the success message');
        assert.equal(view.$('.success').html(), 'a translated success message');

        view.hideSuccess();
        assert.isFalse(view.isSuccessVisible());
      });

      it('hides any previously displayed error messages', function () {
        view.displayError('the error message');
        view.displaySuccess('the success message');
        assert.isTrue(view.isSuccessVisible());
        assert.isFalse(view.isErrorVisible());
      });

      it('`hideSuccess` removes `.visible` from displayed messages', () => {
        view.$('.success').addClass('.visible').html('synthesized success written via template');
        view.hideSuccess();
        assert.isFalse(view.$('.success').hasClass('visible'));
      });
    });

    describe('unsafeDisplaySuccess', () => {
      it('allows HTML in messages', () => {
        view.unsafeDisplaySuccess(HTML_MESSAGE);
        assert.equal(view.$('.success').html(), UNESCAPED_HTML_TRANSLATION);
      });
    });

    describe('navigate', function () {
      beforeEach(function () {
        sinon.spy(notifier, 'trigger');
      });

      it('navigates to a page, propagates the clearQueryParams options', function () {
        view.navigate('signin', { key: 'value' }, { clearQueryParams: true });

        assert.isTrue(notifier.trigger.calledWith('navigate', {
          nextViewData: {
            key: 'value'
          },
          routerOptions: {
            clearQueryParams: true,
          },
          url: 'signin'
        }));
      });

      it('logs an error if an error is passed in the options', function () {
        var err = AuthErrors.toError('SESSION_EXPIRED', viewName);
        view.navigate('signin', {
          error: err
        });

        assert.isTrue(TestHelpers.isErrorLogged(metrics, err));
      });
    });

    describe('navigateAway', () => {
      beforeEach(() => {
        sinon.spy(notifier, 'trigger');
      });

      it('navigates to a page, propagates the clearQueryParams options', () => {
        view.navigateAway('wibble');

        assert.isTrue(notifier.trigger.calledWith('navigate', {
          server: true,
          url: 'wibble'
        }));
      });
    });

    describe('focus', () => {
      beforeEach(() => {
        $('#container').html(view.el);
      });

      it('focuses an element, sets the cursor position', (done) => {
        $('html').addClass('no-touch');
        requiresFocus(() => {
          // webkit fails unless focusing another element first.
          $('#otherElement').focus();

          const elText = 'some text';
          const $focusEl = view.$('#focusMe').val(elText);

          // Use setTimeout because the selection is set in a `focus` handler
          // and this `focus` handler is run first.
          view.$('#focusMe').one('focus', () => setTimeout(() => {
            const focusEl = $focusEl.get(0);
            assert.equal(focusEl.selectionStart, elText.length);
            assert.equal(focusEl.selectionEnd, elText.length);
            done();
          }, 0));

          view.focus('#focusMe');
        }, done);
      });
    });

    describe('placeCursorAt', () => {
      const elText = 'some text';
      let $focusEl;
      let focusEl;

      beforeEach(() => {
        $('#container').html(view.el);
        $focusEl = view.$('#focusMe').val(elText);
        focusEl = $focusEl.get(0);
      });

      it('places the cursor at the end if no position given', () => {
        view.placeCursorAt('#focusMe');

        assert.equal(focusEl.selectionStart, elText.length);
        assert.equal(focusEl.selectionEnd, elText.length);
      });

      it('works correctly with a formatted input[type=tel]', () => {
        const TELEPHONE_NUMBER = '123-456-7890';
        $focusEl = view.$('input[type=tel]').val(TELEPHONE_NUMBER);
        focusEl = $focusEl.get(0);

        view.placeCursorAt('input[type=tel]');
        assert.equal(focusEl.selectionStart, TELEPHONE_NUMBER.length);
        assert.equal(focusEl.selectionEnd, TELEPHONE_NUMBER.length);
      });

      it('places the cursor at the specified position if only start given', () => {
        view.placeCursorAt('#focusMe', elText.length);

        assert.equal(focusEl.selectionStart, elText.length);
        assert.equal(focusEl.selectionEnd, elText.length);
      });

      it('places the cursor at the specified selection if both given', () => {
        view.placeCursorAt('#focusMe', elText.length - 2, elText.length);

        assert.equal(focusEl.selectionStart, elText.length - 2);
        assert.equal(focusEl.selectionEnd, elText.length);
      });
    });

    describe('trackChildView/untrackChildView', function () {
      it('trackChildView tracks a childView, untrackChildView untracks the childView', function () {
        var childView = new BaseView();
        view.trackChildView(childView);
        assert.isTrue(view.isChildViewTracked(childView));

        view.untrackChildView(childView);
        assert.isFalse(view.isChildViewTracked(childView));
      });

      it('childView is automatically untracked when destroyed', function () {
        var childView = new BaseView();
        view.trackChildView(childView);

        childView.destroy();
        assert.isFalse(view.isChildViewTracked(childView));
      });
    });

    describe('BaseView.preventDefaultThen', function () {
      it('can take the name of a function as the name of the event handler', function (done) {
        view.eventHandler = function (event) {
          wrapAssertion(function () {
            assert.isTrue(event.isDefaultPrevented());
          }, done);
        };

        var backboneHandler = BaseView.preventDefaultThen('eventHandler');
        backboneHandler.call(view, new DOMEventMock());
      });

      it('can take a function as the event handler', function (done) {
        function eventHandler(event) {
          wrapAssertion(function () {
            assert.isTrue(event.isDefaultPrevented());
          }, done);
        }

        var backboneHandler = BaseView.preventDefaultThen(eventHandler);
        backboneHandler.call(view, new DOMEventMock());
      });

      it('can take no arguments at all', function () {
        var backboneHandler = BaseView.preventDefaultThen();

        var eventMock = new DOMEventMock();
        backboneHandler.call(view, eventMock);

        assert.isTrue(eventMock.isDefaultPrevented());
      });
    });

    describe('BaseView.cancelEventThen', function () {
      it('can take the name of a function as the name of the event handler', function (done) {
        view.eventHandler = function (event) {
          wrapAssertion(function () {
            assert.isTrue(event.isDefaultPrevented());
            assert.isTrue(event.isPropagationStopped());
          }, done);
        };

        var backboneHandler = BaseView.cancelEventThen('eventHandler');
        backboneHandler.call(view, new DOMEventMock());
      });

      it('can take a function as the event handler', function (done) {
        function eventHandler(event) {
          wrapAssertion(function () {
            assert.isTrue(event.isDefaultPrevented());
            assert.isTrue(event.isPropagationStopped());
          }, done);
        }

        var backboneHandler = BaseView.cancelEventThen(eventHandler);
        backboneHandler.call(view, new DOMEventMock());
      });

      it('can take no arguments at all', function () {
        var backboneHandler = BaseView.cancelEventThen();

        var eventMock = new DOMEventMock();
        backboneHandler.call(view, eventMock);

        assert.isTrue(eventMock.isDefaultPrevented());
        assert.isTrue(eventMock.isPropagationStopped());
      });
    });

    describe('logEvent', function () {
      it('logs an event to the event stream', function () {
        view.logEvent('event1');
        assert.isTrue(TestHelpers.isEventLogged(metrics, 'event1'));
      });
    });

    describe('logEventOnce', function () {
      it('logs an event once to the event stream', function () {
        view.logEventOnce('event1');
        assert.isTrue(TestHelpers.isEventLogged(metrics, 'event1'));
      });
    });

    describe('logFlowEvent', () => {
      beforeEach(() => {
        view.logFlowEvent('foo', 'bar');
      });

      it('logs the correct event', () => {
        assert.isTrue(TestHelpers.isEventLogged(metrics, 'flow.bar.foo'));
      });
    });

    describe('logFlowEventOnce', () => {
      beforeEach(() => {
        view.logFlowEventOnce('baz', 'qux');
      });

      it('logs the correct event', () => {
        assert.isTrue(TestHelpers.isEventLogged(metrics, 'flow.qux.baz'));
      });
    });

    describe('logViewEvent', function () {
      beforeEach(function () {
        view.logViewEvent('event1');
      });

      it('logs an event with the view name as a prefix to the event stream', function () {
        assert.isTrue(TestHelpers.isEventLogged(metrics, 'view.event1'));
      });
    });

    describe('logError', function () {
      it('logs an error to the event stream', function () {
        var err = AuthErrors.toError('INVALID_TOKEN', viewName);

        view.logError(err);
        assert.isTrue(TestHelpers.isErrorLogged(metrics, err));
      });

      it('does not log already logged errors', function () {
        view.metrics.events.clear();

        var err = AuthErrors.toError('INVALID_TOKEN');
        view.logError(err);
        view.logError(err);

        var events = view.metrics.getFilteredData().events;
        assert.equal(events.length, 1);
      });

      it('logs an `Unexpected Error` if no error object is passed in', function () {
        view.metrics.events.clear();
        view.logError();

        var err = AuthErrors.toError('UNEXPECTED_ERROR', viewName);
        assert.isTrue(TestHelpers.isErrorLogged(metrics, err));
      });

      it('can log a string as an error', function () {
        view.metrics.events.clear();
        view.logError('foo');
        var err = new Error('foo');
        err.context = view.getViewName();

        assert.isTrue(TestHelpers.isErrorLogged(metrics, err));
      });

      it('prints a stack trace via console.trace to facilitate debugging if no error object is passed in', function () {
        view.metrics.events.clear();
        sinon.spy(view.window.console, 'trace');

        view.logError();

        assert.isTrue(view.window.console.trace.calledOnce);
        view.window.console.trace.restore();
      });
    });

    describe('fatalError', function () {
      var err;
      var sandbox;

      beforeEach(function () {
        sandbox = sinon.sandbox.create();
        sandbox.spy(ErrorUtils, 'fatalError');

        err = AuthErrors.toError('UNEXPECTED_ERROR');

        return view.fatalError(err);
      });

      afterEach(function () {
        sandbox.restore();
      });

      it('delegates to the ErrorUtils.fatalError', function () {
        assert.isTrue(ErrorUtils.fatalError.calledWith(
          err, view.sentryMetrics, metrics, windowMock, translator));
      });
    });

    describe('context call cache', function () {
      it('multiple calls to `getContext` only call `context` once', function () {
        view._context = null;

        sinon.spy(view, 'context');

        view.getContext();
        view.getContext();

        assert.equal(view.context.callCount, 1);
      });

      it('the context cache is cleared each time `render` is called', function () {
        sinon.spy(view, 'context');

        return view.render()
          .then(function () {
            return view.render();
          })
          .then(function () {
            return view.render();
          })
          .then(function () {
            assert.equal(view.context.callCount, 3);
          });
      });
    });

    describe('invokeBrokerMethod', function () {
      it('invokes the broker method, passing along any extra parameters, invokes the value returned from the broker if a function', function () {
        var behavior = sinon.spy();

        sinon.stub(broker, 'afterSignIn', function () {
          return behavior;
        });

        var extraData = { key: 'value' };
        return view.invokeBrokerMethod('afterSignIn', extraData)
          .then(function () {
            assert.isTrue(broker.afterSignIn.calledWith(extraData));
            assert.isTrue(behavior.calledWith(view));
          });
      });

      it('does not explode if the value returned from the broker is not a function', function () {
        sinon.stub(broker, 'afterSignIn', function () {
          return {};
        });

        return view.invokeBrokerMethod('afterSignIn')
          .then(function () {
            assert.isTrue(broker.afterSignIn.called);
          });
      });
    });

    describe('getViewName', function () {
      describe('with a `viewName` on the view prototype', function () {
        var view;

        before(function () {
          var ViewNameView = View.extend({
            viewName: 'set on the prototype'
          });

          view = new ViewNameView({
            viewName: 'set on creation'
          });
        });

        it('returns the `viewName` from the prototype', function () {
          assert.equal(view.getViewName(), 'set on the prototype');
        });
      });

      describe('without a `viewName` on the view prototype', function () {
        var view;

        before(function () {
          var ViewNameView = View.extend({
            viewName: undefined
          });

          view = new ViewNameView({
            viewName: 'set on creation'
          });
        });

        it('returns `viewName` passed in on creation', function () {
          assert.equal(view.getViewName(), 'set on creation');
        });
      });
    });

    describe('session check', function () {
      beforeEach(function () {
        var SessionView = View.extend({
          checkAuthorization: sinon.spy()
        });

        view = new SessionView({
          window: windowMock
        });

        assert.equal(view.checkAuthorization.callCount, 0);
        $(windowMock).trigger('focus');
      });

      it('checkAuthorization is called on window focus', function () {
        assert.equal(view.checkAuthorization.callCount, 1);
      });
    });

    describe('getSearchParam', () => {
      it('fetches a search parameter', () => {
        windowMock.location.search = '?search=1&another=2';

        assert.equal(view.getSearchParam('search'), '1');
        assert.equal(view.getSearchParam('another'), '2');
        assert.isUndefined(view.getSearchParam('non-existent'));
      });
    });

    describe('getSearchParams', () => {
      it('returns an object representation of window.location.search', () => {
        windowMock.location.search = '?search=1&another=2';

        const searchParams = view.getSearchParams();
        assert.equal(searchParams.search, '1');
        assert.equal(searchParams.another, '2');

        const filteredSearchParams = view.getSearchParams('another');
        assert.notProperty(filteredSearchParams, 'search');
        assert.equal(filteredSearchParams.another, '2');
      });
    });

    describe('events handling', () => {
      it('calls spys on DOM event handlers', () => {
        sinon.spy(view, '_onRequiredClick');

        view.$('#required').click();
        assert.isTrue(view._onRequiredClick.calledOnce);
      });
    });
  });
});
